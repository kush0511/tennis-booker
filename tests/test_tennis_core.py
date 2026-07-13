import json
import unittest
from pathlib import Path

import tennis_booker as legacy
import tennis_core as core


class CompatibilityTests(unittest.TestCase):
    def test_legacy_module_reexports_core_public_api(self):
        self.assertIs(legacy.Config, core.Config)
        self.assertIs(legacy.InputError, core.InputError)
        self.assertIs(legacy.release_at, core.release_at)
        self.assertIs(legacy.booking_payload, core.booking_payload)
        self.assertIs(
            legacy.schedule_booking_targets,
            core.schedule_booking_targets,
        )

    def test_python_defaults_match_cross_runtime_contract(self):
        contract_path = (
            Path(__file__).resolve().parents[1]
            / "shared"
            / "booking-contract.json"
        )
        contract = json.loads(contract_path.read_text("utf-8"))
        defaults = contract["defaults"]
        config = core.Config()
        self.assertEqual(config.booking_lead_days, defaults["bookingLeadDays"])
        self.assertEqual(config.release_hour, defaults["releaseHour"])
        self.assertEqual(config.release_minute, defaults["releaseMinute"])
        self.assertEqual(
            config.arming_window_seconds,
            defaults["armingWindowSeconds"],
        )
        self.assertEqual(config.grace_period_seconds, defaults["gracePeriodSeconds"])
        self.assertEqual(
            config.cancellation_lead_seconds,
            defaults["cancellationLeadSeconds"],
        )
        self.assertEqual(
            config.fire_delay_milliseconds,
            defaults["fireDelayMilliseconds"],
        )
        self.assertEqual(
            config.max_sessions_per_booking,
            defaults["maximumSessions"],
        )
        self.assertEqual(legacy.BASE_URL, contract["api"]["baseUrl"])
        self.assertEqual(legacy.IOS_USER_AGENT, contract["api"]["userAgent"])
        self.assertEqual(list(core.SCHEDULE_STATUSES), contract["statuses"])


class DomainTests(unittest.TestCase):
    def test_schedule_record_builder_is_deterministic(self):
        config = core.Config(
            facility_id=9001,
            facility_category_id=42,
        )
        schedule = core.build_schedule_record(
            "2026-07-17",
            ["07:00-08:00", "08:00-09:00", "07:00-08:00"],
            config,
            schedule_id="schedule-1",
            created_at="2026-07-01T10:00:00+08:00",
        )
        self.assertEqual(schedule["id"], "schedule-1")
        self.assertEqual(
            schedule["event_times"],
            ["07:00-08:00", "08:00-09:00"],
        )
        self.assertEqual(schedule["event_time"], "07:00-08:00, 08:00-09:00")
        self.assertEqual(schedule["facility_id"], 9001)
        self.assertEqual(schedule["facility_category_id"], 42)
        self.assertEqual(schedule["release_at"], "2026-07-03T12:00:00+08:00")
        self.assertEqual(schedule["status"], "pending")
        self.assertEqual(schedule["created_at"], "2026-07-01T10:00:00+08:00")

    def test_rebooking_builder_merges_and_deduplicates_targets(self):
        schedule = {
            "event_day": "2026-07-18",
            "event_times": ["09:00-10:00", "10:00-11:00"],
            "facility_id": 9001,
        }
        active = [
            {
                "event_day": "Fri, 17/07/2026",
                "event_times": ["07:00-08:00", "07:00-08:00"],
            }
        ]
        batch = core.build_rebooking_batch(schedule, active)
        self.assertEqual(
            batch["booking_targets"],
            [
                {
                    "event_day": "2026-07-17",
                    "event_time": "07:00-08:00",
                    "facility_id": 9001,
                },
                {
                    "event_day": "2026-07-18",
                    "event_time": "09:00-10:00",
                    "facility_id": 9001,
                },
                {
                    "event_day": "2026-07-18",
                    "event_time": "10:00-11:00",
                    "facility_id": 9001,
                },
            ],
        )

    def test_rebooking_builder_enforces_limit_before_side_effects(self):
        schedule = {
            "event_day": "2026-07-18",
            "event_times": ["09:00-10:00", "10:00-11:00"],
            "facility_id": 9001,
        }
        active = [
            {
                "event_day": "Fri, 17/07/2026",
                "event_times": ["07:00-08:00"],
            }
        ]
        with self.assertRaisesRegex(core.InputError, "Nothing was cancelled"):
            core.build_rebooking_batch(schedule, active, max_sessions=2)

    def test_active_tennis_filter_excludes_other_facilities_and_statuses(self):
        bookings = [
            {
                "id": 1,
                "facility_name": "Tennis Court",
                "status_name": "Confirmed",
            },
            {
                "id": 2,
                "facility_name": "Tennis Court",
                "status_name": "Cancelled",
            },
            {
                "id": 3,
                "facility_name": "Function Room",
                "status_name": "Confirmed",
            },
        ]
        self.assertEqual(
            core.filter_active_tennis_bookings(bookings),
            [bookings[0]],
        )


class ContractTests(unittest.TestCase):
    def test_har_tokens_are_parsed_without_storage_dependency(self):
        har = {
            "log": {
                "entries": [
                    {
                        "request": {
                            "headers": [
                                {"name": "Authorization", "value": "Bearer z-token"},
                                {"name": "authorization", "value": "Bearer a-token"},
                            ]
                        }
                    }
                ]
            }
        }
        self.assertEqual(
            core.bearer_tokens_from_har(har),
            ["a-token", "z-token"],
        )
        self.assertEqual(core.normalize_bearer_token("Bearer opaque"), "opaque")

    def test_availability_parser_is_available_from_core_and_facade(self):
        payload = {
            "status": 0,
            "content": [
                {
                    "facility": {
                        "id": 9001,
                        "facilityName": "Tennis Court",
                        "multiSelectTime": 2,
                        "condoBookingFacilityDateBeanList": [],
                    }
                }
            ],
        }
        expected = {
            "facility_id": 9001,
            "facility_name": "Tennis Court",
            "maximum_selectable_slots": 2,
            "slots": [],
        }
        self.assertEqual(core.parse_availability_payload(payload, 9001), expected)
        self.assertEqual(legacy.parse_availability_payload(payload, 9001), expected)


if __name__ == "__main__":
    unittest.main()
