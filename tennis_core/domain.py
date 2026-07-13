"""Pure scheduling and booking-domain transformations."""

import datetime as dt
import re

from .config import SGT
from .errors import InputError


def parse_event_day(value):
    try:
        parsed = dt.datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as error:
        raise InputError("Use a real session date in YYYY-MM-DD format.") from error
    if parsed.strftime("%Y-%m-%d") != value:
        raise InputError("Use a real session date in YYYY-MM-DD format.")
    return parsed


def validate_event_time(value):
    match = re.fullmatch(
        r"([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)",
        value,
    )
    if not match:
        raise InputError("Use an hourly range such as 16:00-17:00.")
    start = int(match.group(1)) * 60 + int(match.group(2))
    end = int(match.group(3)) * 60 + int(match.group(4))
    if start >= end:
        raise InputError("The session end time must be after its start time.")


def release_at(event_day, config):
    session_date = parse_event_day(event_day)
    release_date = session_date - dt.timedelta(days=config.booking_lead_days)
    return dt.datetime(
        release_date.year,
        release_date.month,
        release_date.day,
        config.release_hour,
        config.release_minute,
        tzinfo=SGT,
    )


def display_datetime(value):
    return value.astimezone(SGT).strftime("%a, %-d %b %Y %H:%M:%S")


def schedule_event_times(schedule):
    event_times = schedule.get("event_times")
    if isinstance(event_times, list) and event_times:
        return list(dict.fromkeys(event_times))
    value = schedule.get("event_time")
    return [value] if value else []


def normalized_event_day(value):
    try:
        return parse_event_day(value).isoformat()
    except InputError:
        pass
    try:
        return dt.datetime.strptime(value, "%a, %d/%m/%Y").date().isoformat()
    except ValueError as error:
        raise InputError("Dooremi returned an unreadable booking date.") from error


def schedule_booking_targets(schedule):
    raw_targets = schedule.get("booking_targets")
    if not isinstance(raw_targets, list) or not raw_targets:
        raw_targets = [
            {
                "event_day": schedule["event_day"],
                "event_time": event_time,
                "facility_id": schedule["facility_id"],
            }
            for event_time in schedule_event_times(schedule)
        ]
    targets = []
    seen = set()
    for target in raw_targets:
        event_day = normalized_event_day(target["event_day"])
        event_time = target["event_time"]
        facility_id = int(target.get("facility_id") or schedule["facility_id"])
        validate_event_time(event_time)
        key = (event_day, event_time, facility_id)
        if key in seen:
            continue
        seen.add(key)
        targets.append(
            {
                "event_day": event_day,
                "event_time": event_time,
                "facility_id": facility_id,
            }
        )
    return targets


def single_target_schedule(schedule, target):
    single = dict(schedule)
    single["event_day"] = target["event_day"]
    single["event_time"] = target["event_time"]
    single["event_times"] = [target["event_time"]]
    single["facility_id"] = target["facility_id"]
    single.pop("booking_targets", None)
    return single


def filter_active_tennis_bookings(bookings):
    return [
        booking
        for booking in bookings
        if booking.get("status_name") == "Confirmed"
        and "tennis" in booking.get("facility_name", "").casefold()
    ]


def build_rebooking_batch(schedule, active_bookings, max_sessions=6):
    targets = []
    for booking in active_bookings:
        for event_time in booking.get("event_times") or []:
            targets.append(
                {
                    "event_day": normalized_event_day(booking["event_day"]),
                    "event_time": event_time,
                    "facility_id": schedule["facility_id"],
                }
            )
    targets.extend(schedule_booking_targets(schedule))
    batch_schedule = dict(schedule)
    batch_schedule["booking_targets"] = targets
    deduplicated = schedule_booking_targets(batch_schedule)
    if len(deduplicated) > max_sessions:
        raise InputError(
            "{} active and selected sessions would be rebooked. "
            "The safe maximum is {}. Nothing was cancelled.".format(
                len(deduplicated), max_sessions
            )
        )
    batch_schedule["booking_targets"] = deduplicated
    return batch_schedule


def build_schedule_record(
    event_day,
    event_time,
    config,
    *,
    schedule_id,
    created_at,
    status="pending",
):
    event_times = (
        list(dict.fromkeys(event_time))
        if isinstance(event_time, (list, tuple))
        else [event_time]
    )
    if not event_times or len(event_times) > config.max_sessions_per_booking:
        raise InputError(
            "Choose between 1 and {} sessions.".format(
                config.max_sessions_per_booking
            )
        )
    for value in event_times:
        validate_event_time(value)
    release = release_at(event_day, config)
    return {
        "id": schedule_id,
        "event_day": event_day,
        "event_time": ", ".join(event_times),
        "event_times": event_times,
        "facility_id": config.facility_id,
        "facility_category_id": config.facility_category_id,
        "release_at": release.isoformat(),
        "status": status,
        "created_at": created_at,
        "attempted_at": None,
        "result_message": None,
        "booking_order_id": None,
        "booking_order_ids": [],
    }
