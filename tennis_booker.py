#!/usr/bin/python3
"""Local-first Dooremi tennis booking CLI for macOS."""

import contextlib
import concurrent.futures
import dataclasses
import datetime as dt
import fcntl
import getpass
import hashlib
import http.client
import json
import os
import plistlib
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
from email.utils import parsedate_to_datetime
from pathlib import Path

from tennis_core import (
    APIError,
    AuthenticationError,
    BookerError,
    CancellationError,
    Config,
    ConnectivityError,
    InputError,
    NetworkTimeoutError,
    PartialBookingError,
    RateLimitError,
    RebookingSubmissionError,
    SGT,
    StoreError,
    SystemError,
    bearer_tokens_from_har,
    booking_payload,
    build_rebooking_batch,
    build_schedule_record,
    display_datetime,
    filter_active_tennis_bookings,
    normalize_bearer_token,
    normalized_event_day,
    parse_availability_payload,
    parse_event_day,
    release_at,
    schedule_booking_targets,
    schedule_event_times,
    single_target_schedule,
    validate_event_time,
)


APP_NAME = "TennisBooker"
KEYCHAIN_SERVICE = "app.tennis-booker.local"
KEYCHAIN_ACCOUNT = "dooremi-bearer"
AGENT_LABEL = "app.tennis-booker.local"
BASE_URL = "https://api.dooremi.com.sg"
IOS_USER_AGENT = "LifeUp/1 CFNetwork/3860.600.12 Darwin/25.5.0"


class Paths:
    def __init__(self, home=None):
        home = Path(home or Path.home())
        self.support = home / "Library" / "Application Support" / APP_NAME
        self.logs = home / "Library" / "Logs" / APP_NAME
        self.config = self.support / "config.json"
        self.schedules = self.support / "schedules.json"
        self.store_lock = self.support / "store.lock"
        self.runner_lock = self.support / "runner.lock"
        self.runner_log = self.logs / "runner.log"
        self.wake_request = self.support / "wake-test-request.txt"
        self.wake_result = self.support / "wake-test-result.txt"
        self.launch_agent = (
            home / "Library" / "LaunchAgents" / (AGENT_LABEL + ".plist")
        )

    def prepare(self):
        for directory in (
            self.support,
            self.logs,
            self.launch_agent.parent,
        ):
            directory.mkdir(parents=True, exist_ok=True)
            if directory in (self.support, self.logs):
                directory.chmod(0o700)


def now_sgt():
    return dt.datetime.now(tz=SGT)


def mac_power_state():
    """Return actual charging state and separately detected USB-C cabling."""
    output = subprocess.run(
        ["/usr/bin/pmset", "-g", "batt"],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    ).stdout
    source = "ac" if "AC Power" in output else "battery"
    percent_match = re.search(r"(\d+)%", output)
    state = {
        "source": source,
        "external_connected": source == "ac",
        "cable_detected": source == "ac",
        "charging": "charging" in output and "discharging" not in output,
        "percent": int(percent_match.group(1)) if percent_match else None,
    }
    try:
        result = subprocess.run(
            ["/usr/sbin/ioreg", "-a", "-r", "-n", "AppleSmartBattery"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        values = plistlib.loads(result.stdout) if result.stdout else []
        battery = values[0] if values else {}
        fed_details = battery.get("FedDetails") or []
        state["external_connected"] = bool(
            battery.get("ExternalConnected")
            or battery.get("AppleRawExternalConnected")
        )
        state["cable_detected"] = state["external_connected"] or any(
            bool(item.get("FedExternalConnected")) for item in fed_details
        )
        state["charging"] = bool(battery.get("IsCharging"))
    except (OSError, ValueError, TypeError, IndexError):
        pass
    return state


def pmset_datetime(value):
    return value.astimezone().strftime("%m/%d/%y %H:%M:%S")


def parse_selection(value, upper_bound):
    value = value.strip()
    if not value or upper_bound < 1:
        raise InputError("Choose available slot numbers such as 1, 3, or 2-4.")
    selected = set()
    for part in value.split(","):
        part = part.strip()
        if "-" in part:
            bounds = part.split("-")
            if len(bounds) != 2:
                raise InputError("Choose available slot numbers such as 1, 3, or 2-4.")
            try:
                start, end = (int(item.strip()) for item in bounds)
            except ValueError as error:
                raise InputError(
                    "Choose available slot numbers such as 1, 3, or 2-4."
                ) from error
            if start < 1 or end < start or end > upper_bound:
                raise InputError("That selection is outside the displayed slot numbers.")
            selected.update(range(start, end + 1))
        else:
            try:
                index = int(part)
            except ValueError as error:
                raise InputError(
                    "Choose available slot numbers such as 1, 3, or 2-4."
                ) from error
            if index < 1 or index > upper_bound:
                raise InputError("That selection is outside the displayed slot numbers.")
            selected.add(index)
    return sorted(selected)


def atomic_json_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Store:
    def __init__(self, paths=None):
        self.paths = paths or Paths()
        self.paths.prepare()

    @contextlib.contextmanager
    def locked(self):
        with self.paths.store_lock.open("a+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def load_config(self):
        if not self.paths.config.exists():
            config = Config()
            self.save_config(config)
            return config
        try:
            return Config.from_dict(json.loads(self.paths.config.read_text("utf-8")))
        except (ValueError, TypeError, OSError) as error:
            raise StoreError("The configuration file is unreadable.") from error

    def save_config(self, config):
        atomic_json_write(self.paths.config, dataclasses.asdict(config))

    def _load_schedules_unlocked(self):
        if not self.paths.schedules.exists():
            return []
        try:
            value = json.loads(self.paths.schedules.read_text("utf-8"))
        except (ValueError, OSError) as error:
            raise StoreError("The schedules file is unreadable.") from error
        if not isinstance(value, list):
            raise StoreError("The schedules file has an invalid format.")
        return value

    def load_schedules(self):
        with self.locked():
            return self._load_schedules_unlocked()

    def add_schedule(self, schedule):
        with self.locked():
            schedules = self._load_schedules_unlocked()
            requested_times = set(schedule_event_times(schedule))
            for existing in schedules:
                if (
                    existing.get("event_day") == schedule["event_day"]
                    and existing.get("facility_id") == schedule["facility_id"]
                    and existing.get("status") in ("pending", "running")
                    and requested_times.intersection(schedule_event_times(existing))
                ):
                    raise StoreError(
                        "One of those sessions is already scheduled as {}.".format(
                            existing.get("id", "an existing job")
                        )
                    )
            schedules.append(schedule)
            schedules.sort(key=lambda item: item.get("release_at", ""))
            atomic_json_write(self.paths.schedules, schedules)

    def update_schedule(self, schedule):
        with self.locked():
            schedules = self._load_schedules_unlocked()
            for index, existing in enumerate(schedules):
                if existing.get("id") == schedule.get("id"):
                    schedules[index] = schedule
                    atomic_json_write(self.paths.schedules, schedules)
                    return
            raise StoreError("No schedule with ID {}.".format(schedule.get("id")))

    def cancel_schedule(self, schedule_id):
        with self.locked():
            schedules = self._load_schedules_unlocked()
            for schedule in schedules:
                if schedule.get("id") == schedule_id:
                    schedule["status"] = "cancelled"
                    schedule["result_message"] = "Cancelled locally"
                    atomic_json_write(self.paths.schedules, schedules)
                    return schedule
        raise StoreError("No schedule with ID {}.".format(schedule_id))

    def pending_schedules(self):
        return sorted(
            [
                schedule
                for schedule in self.load_schedules()
                if schedule.get("status") == "pending"
            ],
            key=lambda item: item.get("release_at", ""),
        )

    def append_log(self, message):
        self.paths.logs.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now(tz=dt.timezone.utc).isoformat()
        with self.paths.runner_log.open("a", encoding="utf-8") as stream:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            stream.write("[{}] {}\n".format(stamp, message))
            stream.flush()
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        self.paths.runner_log.chmod(0o600)

    def create_wake_test(self, due):
        self.paths.wake_request.write_text(due.isoformat(), encoding="utf-8")
        self.paths.wake_request.chmod(0o600)
        with contextlib.suppress(FileNotFoundError):
            self.paths.wake_result.unlink()

    def process_wake_test(self, now=None):
        now = now or now_sgt()
        if not self.paths.wake_request.exists():
            return False
        try:
            due = dt.datetime.fromisoformat(
                self.paths.wake_request.read_text("utf-8").strip()
            )
        except (ValueError, OSError):
            return False
        if now < due:
            return False
        result = "Background agent ran at {}".format(now.isoformat())
        self.paths.wake_result.write_text(result, encoding="utf-8")
        self.paths.wake_result.chmod(0o600)
        self.paths.wake_request.unlink()
        self.append_log("wake test passed")
        return True


class Keychain:
    def _run(self, arguments, allow_failure=False):
        result = subprocess.run(
            ["/usr/bin/security"] + arguments,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if result.returncode and not allow_failure:
            message = result.stderr.strip() or "macOS Keychain command failed"
            raise SystemError(message)
        return result

    def save(self, raw_token):
        token = normalize_bearer_token(raw_token)
        self._run(
            [
                "add-generic-password",
                "-U",
                "-a",
                KEYCHAIN_ACCOUNT,
                "-s",
                KEYCHAIN_SERVICE,
                "-w",
                token,
            ]
        )

    def load(self):
        result = self._run(
            [
                "find-generic-password",
                "-a",
                KEYCHAIN_ACCOUNT,
                "-s",
                KEYCHAIN_SERVICE,
                "-w",
            ],
            allow_failure=True,
        )
        if result.returncode:
            raise BookerError(
                "No Dooremi token is stored in Keychain. Run `/setup` or `token import-har PATH`."
            )
        token = result.stdout.strip()
        if not token:
            raise BookerError("The Keychain item did not contain a valid token.")
        return token

    def exists(self):
        try:
            self.load()
            return True
        except BookerError:
            return False

    def delete(self):
        self._run(
            [
                "delete-generic-password",
                "-a",
                KEYCHAIN_ACCOUNT,
                "-s",
                KEYCHAIN_SERVICE,
            ],
            allow_failure=True,
        )

    def import_har(self, path):
        try:
            har = json.loads(Path(path).expanduser().read_text("utf-8"))
        except (OSError, ValueError, TypeError) as error:
            raise InputError("That file is not a readable HAR capture.") from error
        tokens = bearer_tokens_from_har(har)
        self.save(tokens[0])
        return len(tokens)


class DooremiClient:
    def __init__(self, timeout=12):
        self.timeout = timeout
        self._connection = None
        self._connection_lock = threading.Lock()

    def close(self):
        with self._connection_lock:
            if self._connection is not None:
                with contextlib.suppress(Exception):
                    self._connection.close()
                self._connection = None

    def _get_connection(self):
        if self._connection is None:
            self._connection = http.client.HTTPSConnection(
                "api.dooremi.com.sg",
                timeout=self.timeout,
            )
        return self._connection

    def _request(self, path, token, body=None, query=None):
        query_string = urllib.parse.urlencode(query or {})
        request_path = path + (("?" + query_string) if query_string else "")
        data = json.dumps(body or {}, separators=(",", ":")).encode("utf-8")
        request_headers = {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
            "User-Agent": IOS_USER_AGENT,
            "Connection": "keep-alive",
        }
        started = time.monotonic()
        with self._connection_lock:
            connection = self._get_connection()
            try:
                connection.request(
                    "POST",
                    request_path,
                    body=data,
                    headers=request_headers,
                )
                response = connection.getresponse()
                raw = response.read()
                headers = dict(response.getheaders())
                status = response.status
                if response.will_close:
                    connection.close()
                    self._connection = None
            except (socket.timeout, TimeoutError) as error:
                connection.close()
                self._connection = None
                raise NetworkTimeoutError(
                    "Dooremi timed out. Your token was not marked invalid."
                ) from error
            except (OSError, http.client.HTTPException) as error:
                connection.close()
                self._connection = None
                raise ConnectivityError(
                    "The Mac could not reach Dooremi: {}.".format(error)
                ) from error

        elapsed = round((time.monotonic() - started) * 1000)
        if status in (401, 403):
            raise AuthenticationError(
                "The Dooremi session has expired. Import a fresh token from a new HAR."
            )
        if status == 429:
            raise RateLimitError(
                "Dooremi is rate-limiting requests. No automatic retry was made."
            )
        if 500 <= status < 600:
            raise APIError("Dooremi is temporarily unavailable.")
        if not 200 <= status < 300:
            raise APIError("Dooremi returned HTTP {}.".format(status))
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise APIError("Dooremi returned an unreadable response.") from error
        if payload.get("status") != 0:
            message = str(payload.get("msg", "Unknown error"))
            error_type = (
                AuthenticationError
                if any(
                    word in message.lower()
                    for word in ("login", "token", "expired", "unauthorized")
                )
                else APIError
            )
            raise error_type(
                "Dooremi rejected the request ({}): {}".format(
                    payload.get("status"), message
                )
            )
        return payload, headers, elapsed

    def warmup(self, token):
        payload, headers, elapsed = self._request("/user/checkLogin", token)
        server_date = None
        if headers.get("Date"):
            with contextlib.suppress(ValueError, TypeError):
                server_date = parsedate_to_datetime(headers["Date"])
        return {"elapsed_ms": elapsed, "server_date": server_date, "payload": payload}

    def availability(self, event_day, facility_id, category_id, token):
        parse_event_day(event_day)
        payload, _, _ = self._request(
            "/user/booking/facilitySlot",
            token,
            query={
                "facilityId": facility_id,
                "eventDate": event_day,
                "facilityCategoryId": category_id,
            },
        )
        return parse_availability_payload(payload, facility_id)

    def preview(self, schedule, token):
        previews = []
        for target in schedule_booking_targets(schedule):
            single = single_target_schedule(schedule, target)
            payload, _, _ = self._request(
                "/user/booking/orderPreview",
                token,
                body=booking_payload(single),
            )
            content = payload.get("content") or {}
            facilities = content.get("bookingOrderFacilityList") or [{}]
            facility = facilities[0]
            previews.append(
                {
                    "message": payload.get("msg", "ok"),
                    "facility_name": facility.get("facilityName")
                    or content.get("facilityName"),
                    "event_day": facility.get("eventDate")
                    or single["event_day"],
                    "event_time": facility.get("eventTime")
                    or target["event_time"],
                }
            )
        first = previews[0]
        return {
            "message": first["message"],
            "facility_name": first["facility_name"],
            "event_day": first["event_day"],
            "event_times": [item["event_time"] for item in previews],
        }

    def create_booking(self, schedule, token):
        batch_schedule, active_bookings = prepare_rebooking_batch(
            schedule,
            token,
            self,
        )
        schedule["prepared_targets"] = schedule_booking_targets(batch_schedule)
        if active_bookings:
            schedule["cancelled_booking_ids"] = cancel_active_tennis_bookings(
                active_bookings,
                token,
                self,
            )
        clients = booking_clients(batch_schedule, self)
        try:
            try:
                warm_booking_clients(clients, token)
                result = submit_booking_requests(batch_schedule, token, clients)
            except PartialBookingError:
                raise
            except Exception as error:
                if schedule.get("cancelled_booking_ids"):
                    raise RebookingSubmissionError(
                        "Active bookings were cancelled, but no replacement "
                        "request was confirmed: {} Refresh My Bookings now.".format(
                            safe_message(error)
                        )
                    ) from error
                raise
            result["cancelled_booking_ids"] = schedule.get(
                "cancelled_booking_ids", []
            )
            return result
        finally:
            close_extra_booking_clients(clients)

    def _create_single_booking(self, schedule, token):
        event_times = schedule_event_times(schedule)
        if len(event_times) != 1:
            raise InputError(
                "Each Dooremi booking request must contain exactly one session."
            )
        payload, _, _ = self._request(
            "/user/booking/createOrderV2",
            token,
            body=booking_payload(schedule),
        )
        content = payload.get("content") or {}
        return {
            "message": content.get("message") or payload.get("msg", "ok"),
            "booking_order_id": content.get("bookingOrderId"),
        }

    def booking_history(self, token, page_size=15, cursor=""):
        payload, _, _ = self._request(
            "/user/booking/history",
            token,
            query={"id": cursor, "pageSize": page_size},
        )
        records = []
        for order in payload.get("content") or []:
            facilities = order.get("facilityList") or []
            if not facilities:
                continue
            first = facilities[0]
            event_times = [
                facility.get("eventTime")
                for facility in facilities
                if facility.get("eventTime")
            ]
            facility_names = list(
                dict.fromkeys(
                    facility.get("facilityName", "Facility")
                    for facility in facilities
                )
            )
            records.append(
                {
                    "id": order.get("id") or first.get("id"),
                    "facility_name": " + ".join(facility_names),
                    "event_day": first.get("eventDate", "—"),
                    "event_time": " · ".join(event_times) or "—",
                    "event_times": event_times,
                    "status": first.get("status"),
                    "status_name": first.get("statusName", "Unknown"),
                    "can_cancel": all(
                        bool(facility.get("canCancel"))
                        for facility in facilities
                    ),
                    "category_type": order.get("categoryType"),
                }
            )
        return records

    def booking_detail(self, booking_id, token):
        payload, _, _ = self._request(
            "/user/booking/detail",
            token,
            query={"orderId": int(booking_id)},
        )
        return payload.get("content") or {}

    def cancel_booking(self, booking_id, token):
        payload, _, _ = self._request(
            "/user/booking/cancel",
            token,
            query={"bookingId": int(booking_id)},
        )
        content = payload.get("content") or {}
        return {
            "message": content.get("statusName")
            or payload.get("msg", "Booking cancelled"),
            "booking_id": content.get("id") or int(booking_id),
        }


def booking_clients(schedule, primary_client=None):
    targets = schedule_booking_targets(schedule)
    if not targets:
        raise InputError("Choose at least one session.")
    if len(targets) > 6:
        raise InputError("Choose at most six sessions per booking attempt.")
    primary_client = primary_client or DooremiClient()
    return [primary_client] + [
        DooremiClient(timeout=primary_client.timeout)
        for _ in targets[1:]
    ]


def close_extra_booking_clients(clients):
    for client in clients[1:]:
        client.close()


def warm_booking_clients(clients, token):
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=len(clients),
        thread_name_prefix="tennis-warmup",
    ) as pool:
        futures = [pool.submit(client.warmup, token) for client in clients]
        return [future.result() for future in futures]


def submit_booking_requests(schedule, token, clients):
    targets = schedule_booking_targets(schedule)
    if len(targets) != len(clients):
        raise InputError("The prepared connection count does not match the sessions.")
    barrier = threading.Barrier(len(targets))

    def submit(client, target):
        barrier.wait()
        started_ns = time.perf_counter_ns()
        try:
            result = client._create_single_booking(
                single_target_schedule(schedule, target),
                token,
            )
            return {
                "target": target,
                "result": result,
                "started_ns": started_ns,
            }
        except Exception as error:
            return {
                "target": target,
                "error": error,
                "started_ns": started_ns,
            }

    results = []
    errors = []
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=len(clients),
        thread_name_prefix="tennis-submit",
    ) as pool:
        futures = [
            pool.submit(submit, client, target)
            for client, target in zip(clients, targets)
        ]
        for future in futures:
            outcome = future.result()
            if "error" in outcome:
                errors.append(outcome)
            else:
                results.append(outcome)

    starts = [item["started_ns"] for item in results + errors]
    submit_skew_ms = (
        round((max(starts) - min(starts)) / 1_000_000, 3)
        if len(starts) > 1
        else 0.0
    )
    if errors:
        if results:
            raise PartialBookingError(results, errors, submit_skew_ms)
        raise errors[0]["error"]

    booking_order_ids = [
        item["result"].get("booking_order_id")
        for item in results
        if item["result"].get("booking_order_id") is not None
    ]
    return {
        "message": "{} of {} sessions confirmed".format(
            len(results), len(targets)
        ),
        "booking_order_id": booking_order_ids[0] if booking_order_ids else None,
        "booking_order_ids": booking_order_ids,
        "results": results,
        "booking_targets": targets,
        "submit_skew_ms": submit_skew_ms,
    }


def active_tennis_bookings(client, token):
    return filter_active_tennis_bookings(
        client.booking_history(token, page_size=50)
    )


def prepare_rebooking_batch(
    schedule,
    token,
    client,
    max_sessions=6,
    active_bookings=None,
):
    active_bookings = (
        active_tennis_bookings(client, token)
        if active_bookings is None
        else active_bookings
    )
    batch_schedule = build_rebooking_batch(
        schedule,
        active_bookings,
        max_sessions=max_sessions,
    )
    return batch_schedule, active_bookings


def cancel_active_tennis_bookings(
    bookings,
    token,
    client,
    attempts=3,
    timing_callback=None,
):
    booking_ids = list(
        dict.fromkeys(
            int(booking["id"])
            for booking in bookings
            if booking.get("id") is not None
        )
    )
    pending = set(booking_ids)
    accepted = set()
    for attempt in range(1, attempts + 1):
        for booking_id in list(pending):
            if booking_id in accepted:
                continue
            started = time.monotonic()
            try:
                client.cancel_booking(booking_id, token)
            except APIError as error:
                if timing_callback:
                    timing_callback(
                        "cancel booking {} attempt {} failed in {}ms: {}".format(
                            booking_id,
                            attempt,
                            round((time.monotonic() - started) * 1000),
                            safe_message(error),
                        )
                    )
            else:
                accepted.add(booking_id)
                if timing_callback:
                    timing_callback(
                        "cancel booking {} accepted in {}ms".format(
                            booking_id,
                            round((time.monotonic() - started) * 1000),
                        )
                    )
            time.sleep(0.15)
        time.sleep(0.2 * attempt)
        verification_started = time.monotonic()
        confirmed_ids = {
            int(booking["id"])
            for booking in active_tennis_bookings(client, token)
            if booking.get("id") is not None
        }
        if timing_callback:
            timing_callback(
                "cancellation verification attempt {} completed in {}ms".format(
                    attempt,
                    round((time.monotonic() - verification_started) * 1000),
                )
            )
        pending.intersection_update(confirmed_ids)
        if not pending:
            return booking_ids
        if attempt < attempts:
            time.sleep(0.35 * attempt)
    raise CancellationError(
        "Dooremi still shows booking{} {} as confirmed after {} attempts. "
        "No rebooking requests were sent.".format(
            "" if len(pending) == 1 else "s",
            ", ".join(str(value) for value in sorted(pending)),
            attempts,
        )
    )


def new_schedule(event_day, event_time, config, status="pending"):
    return build_schedule_record(
        event_day,
        event_time,
        config,
        schedule_id=uuid.uuid4().hex[:8],
        created_at=now_sgt().isoformat(),
        status=status,
    )


class WakeScheduler:
    def schedule(self, schedule, config):
        release = dt.datetime.fromisoformat(schedule["release_at"])
        wake = release - dt.timedelta(seconds=config.wake_lead_seconds)
        if wake <= now_sgt():
            return False
        owner = "{}.{}".format(AGENT_LABEL, schedule["id"])
        result = subprocess.run(
            [
                "/usr/bin/sudo",
                "/usr/bin/pmset",
                "schedule",
                "wake",
                pmset_datetime(wake),
                owner,
            ],
            check=False,
        )
        if result.returncode:
            raise SystemError("macOS did not install the hardware wake event.")
        return True

    def schedule_test(self, minutes):
        wake = now_sgt() + dt.timedelta(minutes=minutes)
        result = subprocess.run(
            [
                "/usr/bin/sudo",
                "/usr/bin/pmset",
                "schedule",
                "wake",
                pmset_datetime(wake),
                AGENT_LABEL + ".wake-test",
            ],
            check=False,
        )
        if result.returncode:
            raise SystemError("macOS did not install the wake test.")
        return wake

    def current(self):
        result = subprocess.run(
            ["/usr/bin/pmset", "-g", "sched"],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        return result.stdout.strip()


class AgentManager:
    def __init__(self, paths=None):
        self.paths = paths or Paths()
        self.paths.prepare()

    def installed(self):
        return self.paths.launch_agent.exists()

    def install(self, script_path=None):
        script_path = str(Path(script_path or __file__).resolve())
        plist = {
            "Label": AGENT_LABEL,
            "ProgramArguments": [
                "/usr/bin/python3",
                script_path,
                "run-due",
            ],
            "RunAtLoad": True,
            "StartInterval": 30,
            "ProcessType": "Background",
            "StandardOutPath": str(self.paths.runner_log),
            "StandardErrorPath": str(self.paths.runner_log),
        }
        with self.paths.launch_agent.open("wb") as stream:
            plistlib.dump(plist, stream, sort_keys=True)
        self.paths.launch_agent.chmod(0o600)
        domain = "gui/{}".format(os.getuid())
        subprocess.run(
            ["/bin/launchctl", "bootout", domain, str(self.paths.launch_agent)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        result = subprocess.run(
            ["/bin/launchctl", "bootstrap", domain, str(self.paths.launch_agent)],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if result.returncode:
            raise SystemError(
                "Could not install the background agent: {}".format(result.stdout.strip())
            )
        subprocess.run(
            ["/bin/launchctl", "enable", "{}/{}".format(domain, AGENT_LABEL)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def uninstall(self):
        domain = "gui/{}".format(os.getuid())
        subprocess.run(
            ["/bin/launchctl", "bootout", domain, str(self.paths.launch_agent)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        with contextlib.suppress(FileNotFoundError):
            self.paths.launch_agent.unlink()

    def status(self):
        result = subprocess.run(
            ["/bin/launchctl", "print", "gui/{}/{}".format(os.getuid(), AGENT_LABEL)],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        return result.stdout


class Executor:
    def __init__(self, store=None, keychain=None, client=None):
        self.store = store or Store()
        self.keychain = keychain or Keychain()
        self.client = client or DooremiClient()

    @contextlib.contextmanager
    def singleton(self):
        self.store.paths.runner_lock.touch(mode=0o600, exist_ok=True)
        with self.store.paths.runner_lock.open("r+", encoding="utf-8") as handle:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
            try:
                yield True
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def run_due(self, current=None):
        current = current or now_sgt()
        with self.singleton() as acquired:
            if not acquired:
                return 0
            self.store.process_wake_test(current)
            config = self.store.load_config()
            attempts = 0
            for schedule in self.store.pending_schedules():
                release = dt.datetime.fromisoformat(schedule["release_at"])
                seconds = (release - current).total_seconds()
                if seconds > config.arming_window_seconds:
                    continue
                if seconds < -config.grace_period_seconds:
                    schedule["status"] = "missed"
                    schedule["result_message"] = (
                        "The Mac did not run within the configured grace period."
                    )
                    self.store.update_schedule(schedule)
                    self.store.append_log(
                        "[{}] marked missed".format(schedule["id"])
                    )
                    continue
                attempts += 1
                self.execute(schedule, config)
            return attempts

    def execute(self, schedule, config):
        release = dt.datetime.fromisoformat(schedule["release_at"])
        hold_seconds = max(int((release - now_sgt()).total_seconds()) + 90, 120)
        caffeinate = subprocess.Popen(
            ["/usr/bin/caffeinate", "-dimsu", "-t", str(hold_seconds)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        clients = []
        batch_schedule = schedule
        active_bookings = []
        try:
            token = self.keychain.load()
            self._sleep_until(
                release - dt.timedelta(seconds=config.cancellation_lead_seconds)
            )
            preparation_started = time.monotonic()
            batch_schedule, active_bookings = prepare_rebooking_batch(
                schedule,
                token,
                self.client,
                max_sessions=config.max_sessions_per_booking,
            )
            self.store.append_log(
                "[{}] rebooking discovery completed in {}ms; {} active booking(s)".format(
                    schedule["id"],
                    round((time.monotonic() - preparation_started) * 1000),
                    len(active_bookings),
                )
            )
            schedule["status"] = "running"
            schedule["attempted_at"] = now_sgt().isoformat()
            schedule["prepared_targets"] = schedule_booking_targets(
                batch_schedule
            )
            self.store.update_schedule(schedule)
            clients = booking_clients(batch_schedule, self.client)
            warmup_results = []
            try:
                results = warm_booking_clients(clients, token)
                warmup_results.extend(result["elapsed_ms"] for result in results)
            except BookerError as error:
                self.store.append_log(
                    "[{}] pre-cancellation warmup warning: {}".format(
                        schedule["id"], safe_message(error)
                    )
                )
            if active_bookings:
                cancelled_ids = cancel_active_tennis_bookings(
                    active_bookings,
                    token,
                    self.client,
                    timing_callback=lambda message: self.store.append_log(
                        "[{}] {}".format(schedule["id"], message)
                    ),
                )
                self.store.append_log(
                    "[{}] cancelled and verified active booking IDs {}; "
                    "they will be rebooked".format(
                        schedule["id"],
                        ",".join(str(value) for value in cancelled_ids),
                    )
                )
                schedule["cancelled_booking_ids"] = cancelled_ids
                self.store.update_schedule(schedule)
            self._sleep_until(release - dt.timedelta(seconds=3))
            try:
                results = warm_booking_clients(clients, token)
                warmup_results.extend(result["elapsed_ms"] for result in results)
            except BookerError as error:
                self.store.append_log(
                    "[{}] final warmup warning: {}".format(
                        schedule["id"], safe_message(error)
                    )
                )
            if warmup_results:
                self.store.append_log(
                    "[{}] booking connections ready; RTT samples {}ms".format(
                        schedule["id"],
                        ",".join(str(value) for value in warmup_results),
                    )
                )

            fire_at = release + dt.timedelta(
                milliseconds=config.fire_delay_milliseconds
            )
            self._sleep_until(fire_at)
            self.store.append_log(
                "[{}] submitting {} {}".format(
                    schedule["id"], schedule["event_day"], schedule["event_time"]
                )
            )

            result = submit_booking_requests(batch_schedule, token, clients)
            schedule["status"] = "succeeded"
            schedule["result_message"] = result["message"]
            schedule["booking_order_id"] = result["booking_order_id"]
            schedule["booking_order_ids"] = result["booking_order_ids"]
            schedule["submitted_targets"] = result["booking_targets"]
            schedule["cancelled_booking_ids"] = [
                booking["id"] for booking in active_bookings
            ]
            self.store.update_schedule(schedule)
            self.store.append_log(
                "[{}] success: {}; synchronized submit skew {}ms".format(
                    schedule["id"],
                    result["message"],
                    result["submit_skew_ms"],
                )
            )
        except PartialBookingError as error:
            schedule["status"] = "partial"
            schedule["attempted_at"] = (
                schedule.get("attempted_at") or now_sgt().isoformat()
            )
            schedule["result_message"] = safe_message(error)
            schedule["booking_order_ids"] = error.booking_order_ids
            schedule["booking_order_id"] = (
                error.booking_order_ids[0]
                if error.booking_order_ids
                else None
            )
            schedule["submitted_targets"] = schedule_booking_targets(
                batch_schedule
            )
            schedule["cancelled_booking_ids"] = [
                booking["id"] for booking in active_bookings
            ]
            with contextlib.suppress(Exception):
                self.store.update_schedule(schedule)
            self.store.append_log(
                "[{}] partial: {}; synchronized submit skew {}ms".format(
                    schedule["id"],
                    safe_message(error),
                    error.submit_skew_ms,
                )
            )
        except Exception as error:
            schedule["status"] = "failed"
            schedule["attempted_at"] = schedule.get("attempted_at") or now_sgt().isoformat()
            message = safe_message(error)
            if (
                schedule.get("cancelled_booking_ids")
                and not isinstance(error, CancellationError)
            ):
                message = (
                    "Active bookings were cancelled, but no replacement request "
                    "was confirmed: {} Refresh My Bookings now.".format(message)
                )
            schedule["result_message"] = message
            with contextlib.suppress(Exception):
                self.store.update_schedule(schedule)
            self.store.append_log(
                "[{}] failed: {}".format(schedule["id"], message)
            )
        finally:
            close_extra_booking_clients(clients)
            if caffeinate.poll() is None:
                caffeinate.terminate()

    @staticmethod
    def _sleep_until(value):
        delay = (value - now_sgt()).total_seconds()
        if delay <= 0:
            return
        if delay > 0.025:
            time.sleep(delay - 0.015)
        while True:
            remaining = (value - now_sgt()).total_seconds()
            if remaining <= 0:
                return
            time.sleep(min(remaining, 0.001))


def safe_message(error):
    value = str(error).strip()
    return value or error.__class__.__name__


class UI:
    enabled = sys.stdout.isatty() and "NO_COLOR" not in os.environ

    @classmethod
    def style(cls, value, code):
        return "\033[{}m{}\033[0m".format(code, value) if cls.enabled else value

    @classmethod
    def bold(cls, value):
        return cls.style(value, "1")

    @classmethod
    def dim(cls, value):
        return cls.style(value, "2")

    @classmethod
    def red(cls, value):
        return cls.style(value, "31")

    @classmethod
    def green(cls, value):
        return cls.style(value, "32")

    @classmethod
    def yellow(cls, value):
        return cls.style(value, "33")

    @classmethod
    def purple(cls, value):
        return cls.style(value, "35")

    @classmethod
    def cyan(cls, value):
        return cls.style(value, "36")

    @classmethod
    def banner(cls):
        print(
            cls.purple(
                "╭──────────────────────────────────────────────────────╮\n"
                "│  🎾  TENNIS BOOKER                                   │\n"
                "│      local · secure · synchronized                   │\n"
                "╰──────────────────────────────────────────────────────╯"
            )
        )

    @classmethod
    def section(cls, value):
        print("\n" + cls.bold(value))

    @classmethod
    def success(cls, value):
        print(cls.green("✓ " + value))

    @classmethod
    def warning(cls, value):
        print(cls.yellow("! " + value))

    @classmethod
    def error(cls, value):
        print(cls.red("× " + value), file=sys.stderr)

    @classmethod
    def info(cls, value):
        print(cls.cyan(value))

    @classmethod
    def muted(cls, value):
        print(cls.dim(value))

    @classmethod
    def ask(cls, question):
        return input(question + ": ")

    @classmethod
    def confirm(cls, question):
        return input(question + " [y/N] ").strip().lower() in ("y", "yes")


class CLI:
    def __init__(self):
        self.paths = Paths()
        self.store = Store(self.paths)
        self.keychain = Keychain()
        self.client = DooremiClient()
        self.agent = AgentManager(self.paths)
        self.wake = WakeScheduler()
        self.executor = Executor(self.store, self.keychain, self.client)

    def run(self, arguments):
        if not arguments:
            try:
                from tennis_tui import run_tui
            except ImportError:
                return self.interactive()
            run_tui()
            return 0
        if arguments == ["--classic"]:
            return self.interactive()
        try:
            self.execute(arguments, interactive=False)
            return 0
        except KeyboardInterrupt:
            print("")
            UI.muted("Cancelled.")
            return 130
        except Exception as error:
            UI.error(safe_message(error))
            return 1

    def interactive(self):
        if UI.enabled:
            print("\033[2J\033[H", end="")
        UI.banner()
        self.print_status(compact=True)
        if not self.keychain.exists():
            UI.warning("First run? Type /setup and I’ll walk you through it.")
        else:
            UI.muted("Try /availability to browse live sessions. Type /help for commands.")
        UI.muted("Your credential is stored in macOS Keychain.")
        while True:
            try:
                line = input("\n{} ".format(UI.purple("❯"))).strip()
            except (EOFError, KeyboardInterrupt):
                print("")
                UI.muted("Goodbye.")
                return 0
            if not line:
                continue
            try:
                arguments = shlex.split(line)
                if arguments and arguments[0].startswith("/"):
                    arguments[0] = arguments[0][1:]
                if arguments[0].lower() in ("quit", "exit"):
                    UI.muted("Goodbye.")
                    return 0
                self.execute(arguments, interactive=True)
            except KeyboardInterrupt:
                print("")
                UI.muted("Cancelled.")
            except Exception as error:
                UI.error(safe_message(error))

    def execute(self, arguments, interactive):
        command = arguments[0].lower()
        rest = arguments[1:]
        if command in ("help", "?"):
            self.help()
        elif command == "setup":
            self.setup(rest)
        elif command in ("availability", "available", "browse"):
            self.availability(rest, choose=interactive)
        elif command == "book":
            if len(rest) >= 2:
                self.schedule(rest)
            else:
                self.availability(rest, choose=interactive)
        elif command == "schedule":
            self.schedule(rest)
        elif command in ("list", "ls"):
            self.list_schedules()
        elif command in ("bookings", "history"):
            self.list_bookings()
        elif command == "cancel-booking":
            self.cancel_booking_command(rest, interactive)
        elif command in ("cancel", "remove", "rm"):
            self.cancel(rest)
        elif command == "token":
            self.token(rest)
        elif command == "config":
            self.config(rest)
        elif command == "status":
            self.print_status(compact=False)
        elif command == "doctor":
            self.doctor()
        elif command == "logs":
            self.logs()
        elif command == "wake-test":
            self.wake_test(rest)
        elif command == "install-agent":
            self.agent.install()
            UI.success("Background agent installed.")
        elif command == "uninstall-agent":
            self.agent.uninstall()
            UI.success("Background agent removed; schedules and token were preserved.")
        elif command == "run-due":
            self.executor.run_due()
        elif command == "run-now":
            self.run_now(rest, interactive)
        elif command == "clear":
            if UI.enabled:
                print("\033[2J\033[H", end="")
            UI.banner()
        else:
            raise InputError("Unknown command “{}”. Type /help.".format(command))

    def setup(self, arguments):
        UI.section("Setup")
        if self.keychain.exists():
            UI.success("Bearer token is already stored in macOS Keychain.")
        else:
            path = arguments[0] if arguments else UI.ask(
                "HAR path (Enter to paste token instead)"
            ).strip()
            if path:
                count = self.keychain.import_har(path)
                UI.success("Bearer token imported into macOS Keychain.")
                if count > 1:
                    UI.warning(
                        "The HAR contained {} distinct tokens; the first was stored.".format(
                            count
                        )
                    )
            else:
                self.keychain.save(getpass.getpass("Bearer token: "))
                UI.success("Bearer token saved in macOS Keychain.")
        if not self.agent.installed():
            self.agent.install()
            UI.success("Background agent installed.")
        else:
            UI.success("Background agent is already installed.")
        UI.muted("Checking the Dooremi session…")
        result = self.client.warmup(self.keychain.load())
        UI.success(
            "Dooremi session is valid ({} ms).".format(result["elapsed_ms"])
        )
        config = self.store.load_config()
        suggestion = (now_sgt().date() + dt.timedelta(days=config.booking_lead_days))
        UI.info("Ready. Try `/availability {}`.".format(suggestion.isoformat()))
        UI.muted("Before relying on a closed lid, run `/wake-test 2` once.")

    def availability(self, arguments, choose):
        config = self.store.load_config()
        suggested = (
            now_sgt().date() + dt.timedelta(days=config.booking_lead_days)
        ).isoformat()
        if arguments:
            event_day = arguments[0]
        elif choose:
            entered = UI.ask("Session date [{}]".format(suggested)).strip()
            event_day = entered or suggested
        else:
            raise InputError("Usage: availability YYYY-MM-DD")
        parse_event_day(event_day)
        UI.muted("Checking {}…".format(event_day))
        result = self.client.availability(
            event_day,
            config.facility_id,
            config.facility_category_id,
            self.keychain.load(),
        )
        selectable = self.show_availability(result, event_day)
        if not choose or not selectable:
            return
        raw = UI.ask("Select a slot number (Enter to leave)").strip()
        if not raw:
            UI.muted("No booking selected.")
            return
        indices = parse_selection(raw, len(selectable))
        maximum = config.max_sessions_per_booking
        if len(indices) > maximum:
            raise InputError(
                "Your rules allow at most {} session{} per booking.".format(
                    maximum, "" if maximum == 1 else "s"
                )
            )
        slots = [selectable[index - 1] for index in indices]
        self.handle_selection(slots, event_day, result, config)

    def show_availability(self, result, event_day):
        UI.section("{} · {}".format(result["facility_name"], event_day))
        selectable = []
        for slot in result["slots"]:
            if slot["available"]:
                selectable.append(slot)
                number = "{:>2}".format(len(selectable))
                print(
                    "  {}  {}  {}".format(
                        UI.green(number),
                        UI.bold(slot["event_time"]),
                        UI.green("available"),
                    )
                )
            else:
                print(
                    "   {}  {}  {}".format(
                        UI.dim("–"),
                        UI.dim(slot["event_time"]),
                        UI.dim("booked"),
                    )
                )
        print("")
        if selectable:
            UI.info(
                "{} session{} available".format(
                    len(selectable), "" if len(selectable) == 1 else "s"
                )
            )
            UI.muted(
                "You may select up to {} sessions.".format(
                    self.store.load_config().max_sessions_per_booking
                )
            )
        else:
            UI.warning("No available sessions were returned for this date.")
        return selectable

    def handle_selection(self, slots, event_day, availability, config):
        release = release_at(event_day, config)
        summary = ", ".join(slot["event_time"] for slot in slots)
        if release > now_sgt():
            UI.section("Schedule booking")
            print("  " + availability["facility_name"])
            print("  {} · {}".format(event_day, summary))
            print("  Attempt at {} SGT".format(display_datetime(release)))
            if not UI.confirm("Schedule this booking?"):
                UI.muted("Nothing scheduled.")
                return
            self.create_schedule(
                event_day,
                [slot["event_time"] for slot in slots],
                config,
            )
            return
        schedule = new_schedule(
            event_day,
            [slot["event_time"] for slot in slots],
            config,
            "running",
        )
        UI.section("Confirm booking now")
        print("  " + availability["facility_name"])
        print(
            "  {} · {}".format(
                schedule["event_day"],
                ", ".join(schedule_event_times(schedule)),
            )
        )
        request_count = len(schedule_event_times(schedule))
        request_text = (
            "Start the automatic cancel-and-rebook transaction with {} new "
            "sessions?".format(request_count)
        )
        if not UI.confirm(request_text):
            UI.muted("Booking cancelled.")
            return
        self.store.add_schedule(schedule)
        try:
            result = self.client.create_booking(schedule, self.keychain.load())
            schedule["status"] = "succeeded"
            schedule["attempted_at"] = now_sgt().isoformat()
            schedule["result_message"] = result["message"]
            schedule["booking_order_id"] = result["booking_order_id"]
            schedule["booking_order_ids"] = result["booking_order_ids"]
            schedule["submitted_targets"] = result["booking_targets"]
            schedule["cancelled_booking_ids"] = result[
                "cancelled_booking_ids"
            ]
            self.store.update_schedule(schedule)
            UI.success(result["message"])
            if result["booking_order_ids"]:
                UI.info(
                    "Booking order IDs: {}".format(
                        ", ".join(
                            str(value) for value in result["booking_order_ids"]
                        )
                    )
                )
        except PartialBookingError as error:
            schedule["status"] = "partial"
            schedule["attempted_at"] = now_sgt().isoformat()
            schedule["result_message"] = safe_message(error)
            schedule["booking_order_ids"] = error.booking_order_ids
            schedule["booking_order_id"] = (
                error.booking_order_ids[0] if error.booking_order_ids else None
            )
            schedule["submitted_targets"] = schedule.get(
                "prepared_targets", []
            )
            with contextlib.suppress(Exception):
                self.store.update_schedule(schedule)
            raise
        except Exception as error:
            schedule["status"] = "failed"
            schedule["attempted_at"] = now_sgt().isoformat()
            schedule["result_message"] = safe_message(error)
            with contextlib.suppress(Exception):
                self.store.update_schedule(schedule)
            raise

    def schedule(self, arguments):
        if len(arguments) < 2:
            raise InputError(
                "Usage: schedule YYYY-MM-DD TIME [TIME], or /availability to browse."
            )
        config = self.store.load_config()
        self.create_schedule(arguments[0], arguments[1:], config)

    def create_schedule(self, event_day, event_time, config):
        event_times = (
            event_time if isinstance(event_time, (list, tuple)) else [event_time]
        )
        if len(event_times) > config.max_sessions_per_booking:
            raise InputError(
                "Choose at most {} sessions.".format(
                    config.max_sessions_per_booking
                )
            )
        for value in event_times:
            validate_event_time(value)
        release = release_at(event_day, config)
        if release <= now_sgt():
            raise InputError(
                "That release time has passed. Use `/availability {}` to book now.".format(
                    event_day
                )
            )
        if not self.agent.installed():
            self.agent.install()
            UI.success("Background agent installed.")
        schedule = new_schedule(event_day, event_times, config)
        self.store.add_schedule(schedule)
        UI.success(
            "Scheduled {} · {}".format(event_day, ", ".join(event_times))
        )
        UI.info("Booking attempt: {} SGT".format(display_datetime(release)))
        UI.info("Schedule ID: " + schedule["id"])
        try:
            UI.muted(
                "Scheduling the hardware wake {}s early; macOS may request your password.".format(
                    config.wake_lead_seconds
                )
            )
            if self.wake.schedule(schedule, config):
                UI.success("Wake event installed.")
        except Exception:
            UI.warning("The schedule was saved, but its hardware wake failed.")
            UI.warning("It can still run if the Mac is already awake.")
        return schedule

    def list_bookings(self):
        bookings = self.client.booking_history(
            self.keychain.load(),
            page_size=15,
        )
        if not bookings:
            UI.muted("No Dooremi bookings were returned.")
            return
        UI.section("Dooremi bookings")
        for booking in bookings:
            marker = UI.green("●") if booking["status_name"] == "Confirmed" else UI.dim("○")
            print(
                "  {} {}  {}  {} · {}".format(
                    marker,
                    UI.bold(str(booking["id"])),
                    booking["status_name"],
                    booking["event_day"],
                    booking["event_time"],
                )
            )
            print(
                "      {}{}".format(
                    booking["facility_name"],
                    " · cancellable" if booking["can_cancel"] else "",
                )
            )

    def cancel_booking_command(self, arguments, interactive):
        if not arguments:
            raise InputError("Usage: cancel-booking BOOKING_ID --confirm")
        try:
            booking_id = int(arguments[0])
        except ValueError as error:
            raise InputError("Booking ID must be a number.") from error
        booking = next(
            (
                item
                for item in self.client.booking_history(self.keychain.load())
                if item["id"] == booking_id
            ),
            None,
        )
        if not booking:
            raise InputError("That booking was not found in recent history.")
        if not booking["can_cancel"]:
            raise InputError("Dooremi says that booking can no longer be cancelled.")
        confirmed = "--confirm" in arguments or (
            interactive
            and UI.confirm(
                "Cancel {} · {}?".format(
                    booking["event_day"],
                    booking["event_time"],
                )
            )
        )
        if not confirmed:
            raise InputError("Cancellation stopped. Add --confirm to proceed.")
        result = self.client.cancel_booking(booking_id, self.keychain.load())
        UI.success(result["message"])

    def list_schedules(self):
        schedules = self.store.load_schedules()
        if not schedules:
            UI.muted("No schedules yet.")
            return
        markers = {
            "pending": UI.yellow("○"),
            "running": UI.cyan("◉"),
            "succeeded": UI.green("●"),
            "partial": UI.yellow("◐"),
            "failed": UI.red("●"),
            "missed": UI.red("●"),
            "cancelled": UI.dim("○"),
        }
        UI.section("Schedules")
        for schedule in sorted(schedules, key=lambda item: item["release_at"]):
            marker = markers.get(schedule.get("status"), "?")
            print(
                "  {} {}  {}  {}".format(
                    marker,
                    UI.bold(schedule["id"]),
                    schedule["event_day"],
                    schedule["event_time"],
                )
            )
            release = dt.datetime.fromisoformat(schedule["release_at"])
            print(
                "      {} · attempt {} SGT".format(
                    schedule["status"], display_datetime(release)
                )
            )
            if schedule.get("result_message"):
                print("      " + UI.dim(schedule["result_message"]))

    def cancel(self, arguments):
        if not arguments:
            raise InputError("Usage: cancel SCHEDULE_ID")
        schedule = self.store.cancel_schedule(arguments[0])
        UI.success(
            "Cancelled {} · {}.".format(
                schedule["event_day"], schedule["event_time"]
            )
        )
        UI.muted("Its already-installed wake event is harmless and may remain.")

    def token(self, arguments):
        if not arguments:
            raise InputError("Usage: token set | import-har PATH | status | delete")
        action = arguments[0].lower()
        if action == "set":
            self.keychain.save(getpass.getpass("Bearer token: "))
            UI.success("Token saved in macOS Keychain.")
        elif action == "import-har":
            if len(arguments) < 2:
                raise InputError("Usage: token import-har /path/to/capture.har")
            count = self.keychain.import_har(arguments[1])
            UI.success("Bearer token imported into macOS Keychain.")
            if count > 1:
                UI.warning(
                    "The HAR contained {} distinct tokens; the first was stored.".format(
                        count
                    )
                )
        elif action == "status":
            if self.keychain.exists():
                UI.success("A Bearer token is available in Keychain.")
            else:
                UI.warning("No token is stored.")
        elif action == "delete":
            self.keychain.delete()
            UI.success("Token deleted from Keychain.")
        else:
            raise InputError("Usage: token set | import-har PATH | status | delete")

    def config(self, arguments):
        config = self.store.load_config()
        if not arguments or arguments[0].lower() == "show":
            self.print_config(config)
            return
        if len(arguments) != 3 or arguments[0].lower() != "set":
            raise InputError("Usage: config set KEY NUMBER")
        try:
            value = int(arguments[2])
        except ValueError as error:
            raise InputError("Configuration values must be whole numbers.") from error
        key = arguments[1].lower()
        fields = {
            "facility": "facility_id",
            "category": "facility_category_id",
            "lead-days": "booking_lead_days",
            "release-hour": "release_hour",
            "release-minute": "release_minute",
            "wake-lead": "wake_lead_seconds",
            "cancellation-lead": "cancellation_lead_seconds",
            "fire-delay": "fire_delay_milliseconds",
            "max-sessions": "max_sessions_per_booking",
        }
        if key not in fields:
            raise InputError("Unknown configuration key {}.".format(key))
        if key == "release-hour" and not 0 <= value <= 23:
            raise InputError("Release hour must be between 0 and 23.")
        if key == "release-minute" and not 0 <= value <= 59:
            raise InputError("Release minute must be between 0 and 59.")
        if key == "max-sessions" and not 1 <= value <= 6:
            raise InputError("Maximum sessions must be between 1 and 6.")
        if value < 0:
            raise InputError("Configuration values cannot be negative.")
        setattr(config, fields[key], value)
        self.store.save_config(config)
        UI.success("Configuration updated.")
        self.print_config(config)

    @staticmethod
    def print_config(config):
        UI.section("Configuration")
        print("  Facility ID       {}".format(config.facility_id))
        print("  Category ID       {}".format(config.facility_category_id))
        print(
            "  Release window    {} days before at {:02d}:{:02d} SGT".format(
                config.booking_lead_days,
                config.release_hour,
                config.release_minute,
            )
        )
        print("  Wake lead         {} seconds".format(config.wake_lead_seconds))
        print(
            "  Cancellation lead {} seconds".format(
                config.cancellation_lead_seconds
            )
        )
        print("  Fire delay        {} ms after noon".format(config.fire_delay_milliseconds))
        print("  Max sessions      {}".format(config.max_sessions_per_booking))
        UI.muted("No credentials are stored in this file.")

    def print_status(self, compact):
        token = self.keychain.exists()
        agent = self.agent.installed()
        pending = len(self.store.pending_schedules())
        if compact:
            token_text = UI.green("● token") if token else UI.yellow("○ token")
            agent_text = UI.green("● agent") if agent else UI.yellow("○ agent")
            print(
                "  {}   {}   {}\n".format(
                    token_text, agent_text, UI.cyan("{} upcoming".format(pending))
                )
            )
            return
        UI.section("Status")
        self.check("Keychain token", token, "Run `/setup`.")
        self.check("Background agent", agent, "Run `install-agent`.")
        UI.info("  ● Pending schedules: {}".format(pending))
        print("")
        UI.muted(self.wake.current())

    @staticmethod
    def check(label, passed, fix):
        if passed:
            UI.success("  " + label)
        else:
            UI.warning("  {} — {}".format(label, fix))

    def doctor(self):
        UI.section("Doctor")
        self.check("Bearer token", self.keychain.exists(), "Run `/setup`.")
        self.check(
            "Background agent", self.agent.installed(), "Run `install-agent`."
        )
        config = self.store.load_config()
        self.check(
            "Facility configuration",
            config.facility_id > 0 and config.facility_category_id > 0,
            "Check `config show`.",
        )
        filevault = subprocess.run(
            ["/usr/bin/fdesetup", "status"],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        ).stdout.strip()
        if "FileVault is On" in filevault:
            UI.info("  ● FileVault is on — use sleep, not shutdown.")
        else:
            UI.info("  ● " + filevault)
        power = mac_power_state()
        self.check(
            "Connected to power",
            power["external_connected"],
            (
                "A cable is detected but macOS is not receiving power."
                if power["cable_detected"]
                else "Plug in before closing the lid."
            ),
        )
        UI.info("  ● Pending schedules: {}".format(len(self.store.pending_schedules())))
        UI.muted("Run `/wake-test 2` before relying on lid-closed execution.")

    def wake_test(self, arguments):
        if arguments and arguments[0].lower() == "status":
            if self.paths.wake_result.exists():
                UI.success(self.paths.wake_result.read_text("utf-8").strip())
            else:
                UI.warning("No completed wake test was found.")
            return
        if not self.agent.installed():
            raise InputError("Install the background agent before a wake test.")
        minutes = int(arguments[0]) if arguments else 2
        if not 1 <= minutes <= 10:
            raise InputError("Wake-test delay must be between 1 and 10 minutes.")
        wake = self.wake.schedule_test(minutes)
        self.store.create_wake_test(wake)
        UI.success("Wake test scheduled for {} SGT.".format(display_datetime(wake)))
        UI.info("Connect power, close the lid, and return after {} minutes.".format(minutes + 1))
        UI.info("Then run: tennis-booker wake-test status")

    def logs(self):
        if not self.paths.runner_log.exists():
            UI.muted("No runner log exists yet.")
            return
        UI.section("Recent runner log")
        lines = self.paths.runner_log.read_text("utf-8", errors="replace").splitlines()
        for line in lines[-30:]:
            print("  " + line)

    def run_now(self, arguments, interactive):
        if not arguments:
            raise InputError("Usage: run-now SCHEDULE_ID --confirm")
        schedule = next(
            (
                item
                for item in self.store.load_schedules()
                if item.get("id") == arguments[0]
            ),
            None,
        )
        if not schedule:
            raise StoreError("No schedule with ID {}.".format(arguments[0]))
        confirmed = "--confirm" in arguments or (
            interactive and UI.confirm("This will create a real booking now. Continue?")
        )
        if not confirmed:
            raise InputError("Real request cancelled. Add --confirm to proceed.")
        result = self.client.create_booking(schedule, self.keychain.load())
        UI.success(result["message"])
        if result["booking_order_ids"]:
            UI.info(
                "Booking order IDs: {}".format(
                    ", ".join(str(value) for value in result["booking_order_ids"])
                )
            )

    def help(self):
        UI.section("Commands")
        print(
            "  /setup [HAR_PATH]          First-time Keychain, agent, and session setup\n"
            "  /availability [DATE]       Show live sessions and select one\n"
            "  /book [DATE]               Friendly alias for availability\n"
            "  /schedule DATE TIME [...]  Schedule up to six sessions\n"
            "  /bookings                  Show recent Dooremi bookings\n"
            "  /cancel-booking ID         Cancel a confirmed Dooremi booking\n"
            "  /list                      Show scheduled and completed attempts\n"
            "  /cancel ID                 Cancel a local schedule\n"
            "  /status                    Show token, agent, and wake state\n"
            "  /doctor                    Check unattended-run prerequisites\n"
            "  /wake-test [MINUTES]       Verify closed-lid wake without booking\n"
            "  /wake-test status          Show the latest wake-test result\n"
            "  /token set                 Enter a Bearer token without echo\n"
            "  /token import-har PATH     Extract a token from a local HAR\n"
            "  /token status|delete       Inspect or remove the Keychain item\n"
            "  /config show               Show non-secret configuration\n"
            "  /config set KEY VALUE      Change IDs, timing, or wake lead\n"
            "  /logs                      Show sanitized runner logs\n"
            "  /clear                     Clear the terminal\n"
            "  /quit                      Exit"
        )
        UI.muted("Hidden service commands: install-agent, uninstall-agent, run-due.")


def main():
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    return CLI().run(sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
