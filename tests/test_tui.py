import asyncio
import datetime as dt
import unittest
from unittest import mock

import tennis_booker as core

try:
    from textual.widgets import Button, TabbedContent
    from tennis_tui import HelpScreen, SlotButton, TennisBookerApp
except ImportError:
    TennisBookerApp = None


@unittest.skipIf(TennisBookerApp is None, "Textual is not installed")
class TUITests(unittest.TestCase):
    def test_immediate_rebooking_confirmation_does_not_call_preview(self):
        app = TennisBookerApp(auto_load=False)
        app.cli.store.load_config = mock.Mock(
            return_value=core.Config(max_sessions_per_booking=6)
        )
        app.event_day = core.now_sgt().date()
        app.selected_times = ["09:00-10:00", "10:00-11:00"]
        app.availability = {"facility_name": "Tennis Court", "slots": []}
        app.bookings_by_id = {
            "100": {
                "id": 100,
                "facility_name": "Tennis Court",
                "event_day": "Thu, 16/07/2026",
                "event_times": ["07:00-08:00", "08:00-09:00"],
                "status_name": "Confirmed",
            }
        }
        app.cli.client.preview = mock.Mock()
        with mock.patch.object(app, "_show_immediate_confirmation") as show:
            app._review_selection()
        show.assert_called_once_with()
        app.cli.client.preview.assert_not_called()

    def test_responsive_layout_and_navigation(self):
        async def scenario():
            app = TennisBookerApp(auto_load=False)
            app.cli.store.load_config = mock.Mock(
                return_value=core.Config(max_sessions_per_booking=6)
            )
            async with app.run_test(size=(110, 40)) as pilot:
                await pilot.pause()
                self.assertFalse(app.screen.has_class("compact"))

                original_day = app.event_day
                with mock.patch.object(app, "load_availability") as refresh:
                    app.action_next_date()
                    refresh.assert_called_once_with()
                self.assertEqual(
                    app.event_day,
                    original_day + dt.timedelta(days=1),
                )

                await pilot.resize_terminal(64, 32)
                await pilot.pause()
                self.assertTrue(app.screen.has_class("compact"))
                self.assertFalse(app.screen.has_class("tiny"))

                await pilot.resize_terminal(48, 30)
                await pilot.pause()
                self.assertTrue(app.screen.has_class("tiny"))

                await pilot.press("ctrl+j")
                await pilot.pause()
                self.assertEqual(
                    app.query_one("#main-tabs", TabbedContent).active,
                    "jobs-tab",
                )

                await pilot.press("?")
                await pilot.pause()
                self.assertIsInstance(app.screen, HelpScreen)
                await pilot.press("escape")

        asyncio.run(scenario())

    def test_live_rows_can_be_selected_without_sending_a_request(self):
        async def scenario():
            app = TennisBookerApp(auto_load=False)
            app.cli.store.load_config = mock.Mock(
                return_value=core.Config(max_sessions_per_booking=6)
            )
            async with app.run_test(size=(110, 40)) as pilot:
                result = {
                    "facility_id": 9001,
                    "facility_name": "Tennis Court",
                    "maximum_selectable_slots": 1,
                    "slots": [
                        {
                            "id": 1,
                            "facility_id": 9001,
                            "event_time": "07:00-08:00",
                            "available": True,
                        },
                        {
                            "id": 2,
                            "facility_id": 9001,
                            "event_time": "08:00-09:00",
                            "available": False,
                        },
                        {
                            "id": 3,
                            "facility_id": 9001,
                            "event_time": "09:00-10:00",
                            "available": True,
                        },
                    ],
                }
                app._availability_request_id = 1
                await app._availability_loaded(
                    1,
                    app.event_day.isoformat(),
                    result,
                )
                await pilot.pause()

                self.assertEqual(len(app.query(SlotButton)), 3)
                original_buttons = list(app.query(SlotButton))
                app._toggle_time("07:00-08:00")
                app._toggle_time("09:00-10:00")
                await pilot.pause()

                self.assertEqual(
                    app.selected_times,
                    ["07:00-08:00", "09:00-10:00"],
                )

                refreshed = dict(result)
                refreshed["slots"] = [
                    dict(slot, available=True) for slot in result["slots"]
                ]
                app._availability_request_id = 2
                await app._availability_loaded(
                    2,
                    app.event_day.isoformat(),
                    refreshed,
                )
                await pilot.pause()
                self.assertTrue(app.query_one("#slots-grid").display)
                self.assertEqual(
                    original_buttons,
                    list(app.query(SlotButton)),
                )
                self.assertFalse(
                    app.query_one("#primary-action", Button).disabled
                )

                app._toggle_time("08:00-09:00")
                self.assertEqual(
                    app.selected_times,
                    ["07:00-08:00", "09:00-10:00", "08:00-09:00"],
                )

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
