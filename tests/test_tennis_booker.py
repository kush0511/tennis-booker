import datetime as dt
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tennis_booker as tb


class DateTests(unittest.TestCase):
    def test_release_is_fourteen_days_before_at_noon(self):
        config = tb.Config()
        release = tb.release_at("2026-07-17", config)
        self.assertEqual(release.isoformat(), "2026-07-03T12:00:00+08:00")

    def test_invalid_time_rejected(self):
        with self.assertRaises(tb.InputError):
            tb.validate_event_time("17:00-16:00")

    def test_default_transaction_limit_is_six(self):
        self.assertEqual(tb.Config().max_sessions_per_booking, 6)

    def test_default_cancellation_lead_is_fifteen_seconds(self):
        self.assertEqual(tb.Config().cancellation_lead_seconds, 15)


class SelectionTests(unittest.TestCase):
    def test_ranges_are_sorted_and_deduplicated(self):
        self.assertEqual(tb.parse_selection("3, 1-2, 2", 4), [1, 2, 3])

    def test_out_of_range_rejected(self):
        with self.assertRaises(tb.InputError):
            tb.parse_selection("5", 4)


class AvailabilityTests(unittest.TestCase):
    def test_parses_available_and_booked_slots(self):
        payload = {
            "status": 0,
            "msg": "ok",
            "content": [
                {
                    "facility": {
                        "id": 9001,
                        "facilityName": "Tennis Court",
                        "multiSelectTime": 1,
                        "condoBookingFacilityDateBeanList": [
                            {
                                "id": 1,
                                "facilityId": 9001,
                                "bookingOrderId": None,
                                "startFrom": "16:00",
                                "endTo": "17:00",
                                "state": 0,
                            },
                            {
                                "id": 2,
                                "facilityId": 9001,
                                "bookingOrderId": 99,
                                "startFrom": "17:00",
                                "endTo": "18:00",
                                "state": 1,
                            },
                        ],
                    }
                }
            ],
        }
        result = tb.parse_availability_payload(payload, 9001)
        self.assertTrue(result["slots"][0]["available"])
        self.assertFalse(result["slots"][1]["available"])
        self.assertEqual(result["slots"][0]["event_time"], "16:00-17:00")

    def test_api_level_error_is_preserved(self):
        with self.assertRaisesRegex(tb.APIError, "Booking limit reached"):
            tb.parse_availability_payload(
                {"status": 12, "msg": "Booking limit reached"}, 9001
            )


class APITests(unittest.TestCase):
    @staticmethod
    def token_with_created_at(created_at):
        def encode(value):
            return tb.base64.urlsafe_b64encode(
                json.dumps(value).encode("utf-8")
            ).decode("ascii").rstrip("=")

        return "{}.{}.signature".format(
            encode({"alg": "HS256", "typ": "JWT"}),
            encode({"ct": created_at}),
        )

    def test_unauthorized_response_has_actionable_message(self):
        response = mock.Mock(
            status=401,
            will_close=False,
        )
        response.read.return_value = b'{"status":401}'
        response.getheaders.return_value = []
        connection = mock.Mock()
        connection.getresponse.return_value = response
        client = tb.DooremiClient()
        client._connection = connection
        with self.assertRaisesRegex(tb.APIError, "fresh token"):
            client.warmup("not-a-real-token")

    def test_booking_payload_matches_captured_api(self):
        schedule = {
            "event_day": "2026-07-17",
            "event_time": "16:00-17:00",
            "facility_id": 9001,
        }
        self.assertEqual(
            tb.booking_payload(schedule),
            {
                "eventDay": "2026-07-17",
                "bookingOrderFacilityList": [
                    {"facilityId": 9001, "eventTime": "16:00-17:00"}
                ],
            },
        )

    def test_pre_migration_credential_is_blocked_before_booking_transport(self):
        stale = self.token_with_created_at(
            dt.datetime(2026, 1, 14, 15, 50, 16, tzinfo=dt.timezone.utc).timestamp()
        )
        client = tb.DooremiClient()
        client._request = mock.Mock()
        schedule = {
            "event_day": "2026-08-21",
            "event_times": ["07:00-08:00"],
            "facility_id": 9001,
        }
        with self.assertRaisesRegex(
            tb.ClientUpgradeRequiredError,
            "Nothing was cancelled or submitted",
        ):
            client.create_booking(schedule, stale)
        client._request.assert_not_called()

    def test_current_app_credential_age_is_accepted(self):
        current = self.token_with_created_at(
            dt.datetime(2026, 8, 7, 4, 0, tzinfo=dt.timezone.utc).timestamp()
        )
        self.assertEqual(tb.booking_credential_info(current)["status"], "current")

    def test_latest_version_provider_message_is_a_terminal_upgrade_error(self):
        response = mock.Mock(status=200, will_close=False)
        response.read.return_value = json.dumps(
            {
                "status": 1,
                "msg": "Please update to the latest version to complete payment.",
            }
        ).encode("utf-8")
        response.getheaders.return_value = []
        connection = mock.Mock()
        connection.getresponse.return_value = response
        client = tb.DooremiClient()
        client._connection = connection
        with self.assertRaises(tb.ClientUpgradeRequiredError):
            client.warmup("opaque-token")

    def test_preview_payload_can_describe_two_sessions(self):
        schedule = {
            "event_day": "2026-07-17",
            "event_time": "07:00-08:00, 08:00-09:00",
            "event_times": ["07:00-08:00", "08:00-09:00"],
            "facility_id": 9001,
        }
        self.assertEqual(
            tb.booking_payload(schedule)["bookingOrderFacilityList"],
            [
                {"facilityId": 9001, "eventTime": "07:00-08:00"},
                {"facilityId": 9001, "eventTime": "08:00-09:00"},
            ],
        )

    def test_single_booking_request_contains_only_one_session(self):
        client = tb.DooremiClient()
        client._request = mock.Mock(
            return_value=(
                {
                    "status": 0,
                    "msg": "ok",
                    "content": {"bookingOrderId": 101},
                },
                {},
                20,
            )
        )
        schedule = {
            "event_day": "2026-07-17",
            "event_time": "07:00-08:00",
            "event_times": ["07:00-08:00"],
            "facility_id": 9001,
        }
        result = client._create_single_booking(schedule, "token")
        self.assertEqual(result["booking_order_id"], 101)
        self.assertEqual(
            client._request.call_args.kwargs["body"]["bookingOrderFacilityList"],
            [{"facilityId": 9001, "eventTime": "07:00-08:00"}],
        )

    def test_two_sessions_are_released_as_independent_requests(self):
        calls = []
        calls_lock = tb.threading.Lock()

        class FakeClient:
            def __init__(self, order_id):
                self.order_id = order_id

            def _create_single_booking(self, schedule, token):
                with calls_lock:
                    calls.append(
                        (schedule["event_times"], token, tb.time.perf_counter_ns())
                    )
                return {
                    "message": "ok",
                    "booking_order_id": self.order_id,
                }

        schedule = {
            "event_day": "2026-07-17",
            "event_times": ["07:00-08:00", "08:00-09:00"],
            "event_time": "07:00-08:00, 08:00-09:00",
            "facility_id": 9001,
        }
        result = tb.submit_booking_requests(
            schedule,
            "token",
            [FakeClient(101), FakeClient(102)],
        )
        self.assertCountEqual(
            [item[0] for item in calls],
            [["07:00-08:00"], ["08:00-09:00"]],
        )
        self.assertEqual(result["booking_order_ids"], [101, 102])
        self.assertLess(result["submit_skew_ms"], 100)

    def test_partial_two_session_result_is_not_retried(self):
        class FakeClient:
            def __init__(self, result=None, error=None):
                self.result = result
                self.error = error
                self.calls = 0

            def _create_single_booking(self, schedule, token):
                self.calls += 1
                if self.error:
                    raise self.error
                return self.result

        first = FakeClient(
            result={"message": "ok", "booking_order_id": 101}
        )
        second = FakeClient(error=tb.NetworkTimeoutError("timed out"))
        schedule = {
            "event_day": "2026-07-17",
            "event_times": ["07:00-08:00", "08:00-09:00"],
            "facility_id": 9001,
        }
        with self.assertRaises(tb.PartialBookingError) as raised:
            tb.submit_booking_requests(schedule, "token", [first, second])
        self.assertEqual(raised.exception.booking_order_ids, [101])
        self.assertEqual(first.calls, 1)
        self.assertEqual(second.calls, 1)

    def test_six_cross_date_targets_are_submitted_together(self):
        calls = []
        calls_lock = tb.threading.Lock()

        class FakeClient:
            def __init__(self, order_id):
                self.order_id = order_id

            def _create_single_booking(self, schedule, token):
                with calls_lock:
                    calls.append((schedule["event_day"], schedule["event_time"]))
                return {
                    "message": "ok",
                    "booking_order_id": self.order_id,
                }

        targets = [
            {
                "event_day": "2026-07-17" if index < 3 else "2026-07-18",
                "event_time": "{:02d}:00-{:02d}:00".format(
                    7 + index, 8 + index
                ),
                "facility_id": 9001,
            }
            for index in range(6)
        ]
        schedule = {
            "event_day": "2026-07-18",
            "event_time": "12:00-13:00",
            "event_times": ["12:00-13:00"],
            "facility_id": 9001,
            "booking_targets": targets,
        }
        result = tb.submit_booking_requests(
            schedule,
            "token",
            [FakeClient(index) for index in range(6)],
        )
        self.assertCountEqual(calls, [
            (target["event_day"], target["event_time"]) for target in targets
        ])
        self.assertEqual(result["booking_order_ids"], list(range(6)))

    def test_active_tennis_sessions_merge_before_six_slot_limit(self):
        active = [
            {
                "id": 100,
                "facility_name": "Tennis Court",
                "event_day": "Fri, 17/07/2026",
                "event_times": ["07:00-08:00", "08:00-09:00"],
                "status_name": "Confirmed",
            }
        ]
        schedule = {
            "event_day": "2026-07-18",
            "event_time": "19:00-20:00, 20:00-21:00",
            "event_times": ["19:00-20:00", "20:00-21:00"],
            "facility_id": 9001,
        }
        batch, bookings = tb.prepare_rebooking_batch(
            schedule,
            "token",
            mock.Mock(),
            active_bookings=active,
        )
        self.assertEqual(bookings, active)
        self.assertEqual(len(tb.schedule_booking_targets(batch)), 4)
        self.assertEqual(
            tb.schedule_booking_targets(batch)[0]["event_day"],
            "2026-07-17",
        )

    def test_over_limit_stops_before_cancellation(self):
        active = [
            {
                "id": 100,
                "facility_name": "Tennis Court",
                "event_day": "Fri, 17/07/2026",
                "event_times": [
                    "07:00-08:00",
                    "08:00-09:00",
                    "09:00-10:00",
                    "10:00-11:00",
                    "11:00-12:00",
                ],
                "status_name": "Confirmed",
            }
        ]
        schedule = {
            "event_day": "2026-07-18",
            "event_times": ["19:00-20:00", "20:00-21:00"],
            "facility_id": 9001,
        }
        with self.assertRaisesRegex(tb.InputError, "Nothing was cancelled"):
            tb.prepare_rebooking_batch(
                schedule,
                "token",
                mock.Mock(),
                active_bookings=active,
            )

    @mock.patch.object(tb.time, "sleep")
    def test_cancellation_is_verified_and_retries_only_remaining_order(
        self, sleep
    ):
        class FakeClient:
            def __init__(self):
                self.active = {100, 101}
                self.cancel_calls = []

            def cancel_booking(self, booking_id, token):
                self.cancel_calls.append(booking_id)
                if booking_id == 101 and self.cancel_calls.count(101) == 1:
                    raise tb.APIError("transient system error")
                self.active.remove(booking_id)
                return {"message": "Cancelled", "booking_id": booking_id}

            def booking_history(self, token, page_size):
                return [
                    {
                        "id": booking_id,
                        "facility_name": "Tennis Court",
                        "event_day": "Fri, 17/07/2026",
                        "event_times": ["07:00-08:00"],
                        "status_name": "Confirmed",
                    }
                    for booking_id in sorted(self.active)
                ]

        client = FakeClient()
        bookings = client.booking_history("token", 50)
        result = tb.cancel_active_tennis_bookings(
            bookings,
            "token",
            client,
        )
        self.assertEqual(result, [100, 101])
        self.assertEqual(client.cancel_calls, [100, 101, 101])
        self.assertFalse(client.active)

    @mock.patch.object(tb.time, "sleep")
    def test_accepted_cancellation_is_polled_without_resubmission(self, sleep):
        class FakeClient:
            def __init__(self):
                self.cancel_calls = []
                self.history_calls = 0

            def cancel_booking(self, booking_id, token):
                self.cancel_calls.append(booking_id)
                return {"message": "Cancelled", "booking_id": booking_id}

            def booking_history(self, token, page_size):
                self.history_calls += 1
                if self.history_calls == 1:
                    return [
                        {
                            "id": 100,
                            "facility_name": "Tennis Court",
                            "event_day": "Fri, 17/07/2026",
                            "event_times": ["07:00-08:00"],
                            "status_name": "Confirmed",
                        }
                    ]
                return []

        client = FakeClient()
        result = tb.cancel_active_tennis_bookings(
            [
                {
                    "id": 100,
                    "facility_name": "Tennis Court",
                    "event_day": "Fri, 17/07/2026",
                    "event_times": ["07:00-08:00"],
                    "status_name": "Confirmed",
                }
            ],
            "token",
            client,
        )
        self.assertEqual(result, [100])
        self.assertEqual(client.cancel_calls, [100])
        self.assertEqual(client.history_calls, 2)

    @mock.patch.object(tb.time, "sleep")
    def test_immediate_rebooking_cancels_before_submitting_all_four(
        self, sleep
    ):
        client = tb.DooremiClient()
        active = [
            {
                "id": 100,
                "facility_name": "Tennis Court",
                "event_day": "Thu, 16/07/2026",
                "event_times": ["07:00-08:00", "08:00-09:00"],
                "status_name": "Confirmed",
            }
        ]
        timeline = []

        def booking_history(token, page_size):
            return list(active)

        def cancel_booking(booking_id, token):
            timeline.append("cancel")
            active.clear()
            return {"message": "Cancelled", "booking_id": booking_id}

        client.booking_history = mock.Mock(side_effect=booking_history)
        client.cancel_booking = mock.Mock(side_effect=cancel_booking)
        schedule = {
            "event_day": "2026-07-17",
            "event_times": ["09:00-10:00", "10:00-11:00"],
            "facility_id": 9001,
        }

        def submit(batch, token, clients):
            timeline.append("submit")
            self.assertFalse(active)
            targets = tb.schedule_booking_targets(batch)
            self.assertEqual(len(targets), 4)
            return {
                "message": "4 of 4 sessions confirmed",
                "booking_order_id": 200,
                "booking_order_ids": [200, 201, 202, 203],
                "results": [],
                "booking_targets": targets,
                "submit_skew_ms": 0.1,
            }

        clients = [client, mock.Mock(), mock.Mock(), mock.Mock()]
        with mock.patch.object(tb, "booking_clients", return_value=clients), \
             mock.patch.object(tb, "warm_booking_clients"), \
             mock.patch.object(tb, "submit_booking_requests", side_effect=submit):
            result = client.create_booking(schedule, "token")

        self.assertEqual(timeline, ["cancel", "submit"])
        self.assertEqual(result["booking_order_ids"], [200, 201, 202, 203])
        self.assertEqual(result["cancelled_booking_ids"], [100])
        client.cancel_booking.assert_called_once_with(100, "token")

    def test_scheduled_rebooking_cancels_before_synchronized_submit(self):
        with tempfile.TemporaryDirectory() as directory:
            store = tb.Store(tb.Paths(home=directory))
            config = tb.Config(max_sessions_per_booking=6)
            schedule = tb.new_schedule(
                "2027-07-18",
                ["19:00-20:00", "20:00-21:00"],
                config,
            )
            store.add_schedule(schedule)
            active = [
                {
                    "id": 100,
                    "facility_name": "Tennis Court",
                    "event_day": "Fri, 17/07/2026",
                    "event_times": ["07:00-08:00", "08:00-09:00"],
                    "status_name": "Confirmed",
                }
            ]
            batch = dict(schedule)
            batch["booking_targets"] = [
                {
                    "event_day": "2026-07-17",
                    "event_time": "07:00-08:00",
                    "facility_id": 9001,
                },
                {
                    "event_day": "2026-07-17",
                    "event_time": "08:00-09:00",
                    "facility_id": 9001,
                },
                {
                    "event_day": "2027-07-18",
                    "event_time": "19:00-20:00",
                    "facility_id": 9001,
                },
                {
                    "event_day": "2027-07-18",
                    "event_time": "20:00-21:00",
                    "facility_id": 9001,
                },
            ]
            timeline = []
            clients = [mock.Mock() for _ in range(4)]

            def cancel(bookings, token, client, timing_callback=None):
                timeline.append("cancel")
                return [100]

            def warm(prepared_clients, token):
                timeline.append("warm")
                return [{"elapsed_ms": 1}] * 4

            def submit(prepared, token, prepared_clients):
                timeline.append("submit")
                self.assertEqual(
                    timeline,
                    ["warm", "cancel", "warm", "submit"],
                )
                targets = tb.schedule_booking_targets(prepared)
                self.assertEqual(len(targets), 4)
                return {
                    "message": "4 of 4 sessions confirmed",
                    "booking_order_id": 200,
                    "booking_order_ids": [200, 201, 202, 203],
                    "results": [],
                    "booking_targets": targets,
                    "submit_skew_ms": 0.1,
                }

            keychain = mock.Mock()
            keychain.load.return_value = "token"
            executor = tb.Executor(store, keychain, mock.Mock())
            process = mock.Mock()
            process.poll.return_value = 1
            with mock.patch.object(
                tb,
                "prepare_rebooking_batch",
                return_value=(batch, active),
            ), mock.patch.object(
                tb,
                "cancel_active_tennis_bookings",
                side_effect=cancel,
            ), mock.patch.object(
                tb,
                "booking_clients",
                return_value=clients,
            ), mock.patch.object(
                tb,
                "warm_booking_clients",
                side_effect=warm,
            ), mock.patch.object(
                tb,
                "submit_booking_requests",
                side_effect=submit,
            ), mock.patch.object(
                tb.subprocess,
                "Popen",
                return_value=process,
            ), mock.patch.object(
                executor,
                "_sleep_until",
            ):
                executor.execute(schedule, config)

            saved = next(
                item
                for item in store.load_schedules()
                if item["id"] == schedule["id"]
            )
            self.assertEqual(saved["status"], "succeeded")
            self.assertEqual(saved["cancelled_booking_ids"], [100])
            self.assertEqual(len(saved["submitted_targets"]), 4)
            self.assertEqual(timeline, ["warm", "cancel", "warm", "submit"])

    def test_history_shape_and_cancel_call_match_capture(self):
        payload = {
            "status": 0,
            "content": [
                {
                    "id": 700001,
                    "categoryType": 2,
                    "facilityList": [
                        {
                            "facilityName": "Tennis Court",
                            "eventDate": "Fri, 17/07/2026",
                            "eventTime": "15:00-16:00",
                            "status": 1,
                            "statusName": "Confirmed",
                            "canCancel": True,
                        },
                        {
                            "facilityName": "Tennis Court",
                            "eventDate": "Fri, 17/07/2026",
                            "eventTime": "16:00-17:00",
                            "status": 1,
                            "statusName": "Confirmed",
                            "canCancel": True,
                        }
                    ],
                }
            ],
        }
        client = tb.DooremiClient()
        client._request = mock.Mock(
            side_effect=[
                (payload, {}, 30),
                (
                    {
                        "status": 0,
                        "msg": "ok",
                        "content": {
                            "id": 700001,
                            "statusName": "Cancelled",
                        },
                    },
                    {},
                    40,
                ),
            ]
        )
        history = client.booking_history("token")
        self.assertEqual(len(history), 1)
        self.assertEqual(
            history[0]["event_times"],
            ["15:00-16:00", "16:00-17:00"],
        )
        self.assertTrue(history[0]["can_cancel"])
        self.assertEqual(history[0]["status_name"], "Confirmed")
        result = client.cancel_booking(700001, "token")
        self.assertEqual(result["message"], "Cancelled")
        self.assertEqual(
            client._request.call_args_list[1].kwargs["query"],
            {"bookingId": 700001},
        )

    def test_request_preserves_captured_iphone_profile(self):
        response = mock.Mock(status=200, will_close=False)
        response.read.return_value = b'{"status":0,"content":{}}'
        response.getheaders.return_value = []
        connection = mock.Mock()
        connection.getresponse.return_value = response
        client = tb.DooremiClient()
        client._connection = connection
        client.warmup("opaque-token")
        headers = connection.request.call_args.kwargs["headers"]
        self.assertEqual(headers["User-Agent"], tb.IOS_USER_AGENT)
        self.assertEqual(headers["Authorization"], "Bearer opaque-token")

    def test_timeout_is_not_reported_as_invalid_authentication(self):
        connection = mock.Mock()
        connection.request.side_effect = TimeoutError()
        client = tb.DooremiClient()
        client._connection = connection
        with self.assertRaises(tb.NetworkTimeoutError):
            client.warmup("still-valid-token")


class StoreTests(unittest.TestCase):
    def test_duplicate_pending_schedule_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = tb.Paths(home=directory)
            store = tb.Store(paths)
            schedule = tb.new_schedule(
                "2027-07-17", "16:00-17:00", tb.Config()
            )
            store.add_schedule(schedule)
            duplicate = dict(schedule)
            duplicate["id"] = "duplicate"
            with self.assertRaises(tb.StoreError):
                store.add_schedule(duplicate)

    def test_overlapping_grouped_schedule_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            store = tb.Store(tb.Paths(home=directory))
            config = tb.Config()
            store.add_schedule(
                tb.new_schedule(
                    "2027-07-17",
                    ["16:00-17:00", "17:00-18:00"],
                    config,
                )
            )
            with self.assertRaises(tb.StoreError):
                store.add_schedule(
                    tb.new_schedule(
                        "2027-07-17",
                        "17:00-18:00",
                        config,
                    )
                )


if __name__ == "__main__":
    unittest.main()
