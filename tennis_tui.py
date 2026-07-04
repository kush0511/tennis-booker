#!/usr/bin/env python3
"""Full-screen terminal interface for Tennis Booker."""

import contextlib
import datetime as dt
import io
import os
import subprocess
import time
from pathlib import Path

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, Grid, Horizontal, Vertical, VerticalScroll
from textual.events import Resize
from textual.screen import ModalScreen
from textual.widgets import (
    Button,
    DataTable,
    Footer,
    Input,
    Label,
    LoadingIndicator,
    RichLog,
    Static,
    TabbedContent,
    TabPane,
)

import tennis_booker as core


def relative_day(value):
    today = core.now_sgt().date()
    delta = (value - today).days
    if delta == 0:
        return "Today"
    if delta == 1:
        return "Tomorrow"
    if delta == -1:
        return "Yesterday"
    return value.strftime("%a, %-d %b")


def release_summary(event_day, config):
    release = core.release_at(event_day, config)
    delta = release - core.now_sgt()
    if delta.total_seconds() <= 0:
        return "Booking window is open · books immediately"
    seconds = int(delta.total_seconds())
    days, seconds = divmod(seconds, 86_400)
    hours, minutes = divmod(seconds // 60, 60)
    if days:
        distance = "{}d {}h".format(days, hours)
    elif hours:
        distance = "{}h {}m".format(hours, minutes)
    else:
        distance = "{}m".format(max(1, minutes))
    return "Opens {} · in {}".format(
        release.strftime("%a, %-d %b at %H:%M SGT"), distance
    )


class SlotButton(Button):
    """Compact availability tile."""

    def __init__(self, slot, index):
        self.slot = slot
        super().__init__(
            "",
            id="slot-{}".format(index),
            classes="slot-button",
            disabled=not slot["available"],
        )


class ConfirmScreen(ModalScreen):
    """Reusable, keyboard-friendly confirmation dialog."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False),
        Binding("enter", "confirm", "Confirm", show=False),
    ]

    def __init__(
        self,
        title,
        body,
        action_label="Confirm",
        danger=False,
    ):
        super().__init__()
        self.dialog_title = title
        self.body = body
        self.action_label = action_label
        self.danger = danger

    def compose(self) -> ComposeResult:
        with Container(id="dialog"):
            yield Label(self.dialog_title, id="dialog-title")
            yield Static(self.body, id="dialog-body")
            with Horizontal(id="dialog-actions"):
                yield Button("Cancel", id="dialog-cancel")
                yield Button(
                    self.action_label,
                    id="dialog-confirm",
                    variant="error" if self.danger else "success",
                )

    def on_mount(self):
        self.query_one("#dialog-confirm", Button).focus()

    def on_button_pressed(self, event):
        self.dismiss(event.button.id == "dialog-confirm")

    def action_cancel(self):
        self.dismiss(False)

    def action_confirm(self):
        self.dismiss(True)


class SetupScreen(ModalScreen):
    """First-run credential setup without exposing secrets."""

    BINDINGS = [Binding("escape", "cancel", "Cancel", show=False)]

    def compose(self) -> ComposeResult:
        with Container(id="setup-dialog"):
            yield Label("Connect Dooremi", id="dialog-title")
            yield Static(
                "Import a local HAR capture, or paste the Bearer token directly. "
                "The credential is saved only in macOS Keychain.",
                classes="dialog-copy",
            )
            yield Label("HAR capture", classes="field-label")
            yield Input(
                placeholder="/path/to/dooremi-capture.har",
                id="setup-har",
            )
            yield Static("— or —", classes="or-divider")
            yield Label("Bearer token", classes="field-label")
            yield Input(
                placeholder="Token is hidden while you type",
                password=True,
                id="setup-token",
            )
            yield Static(
                "The HAR itself is never copied or stored.",
                classes="microcopy",
            )
            with Horizontal(id="dialog-actions"):
                yield Button("Cancel", id="setup-cancel")
                yield Button("Connect securely", id="setup-confirm", variant="success")

    def on_mount(self):
        self.query_one("#setup-har", Input).focus()

    def on_input_submitted(self, event):
        self.action_submit()

    def on_button_pressed(self, event):
        if event.button.id == "setup-cancel":
            self.dismiss(None)
        elif event.button.id == "setup-confirm":
            self.action_submit()

    def action_cancel(self):
        self.dismiss(None)

    def action_submit(self):
        har = self.query_one("#setup-har", Input).value.strip()
        token = self.query_one("#setup-token", Input).value.strip()
        if not har and not token:
            self.app.notify(
                "Choose a HAR capture or enter a token.",
                title="Nothing to import",
                severity="warning",
            )
            return
        self.dismiss({"har": har, "token": token})


class HelpScreen(ModalScreen):
    BINDINGS = [
        Binding("escape", "close", "Close", show=False),
        Binding("question_mark", "close", "Close", show=False),
    ]

    def compose(self) -> ComposeResult:
        with Container(id="help-dialog"):
            yield Label("Keyboard map", id="dialog-title")
            yield Static(
                "[b]← / →[/b]  Previous or next booking date\n"
                "[b]r[/b]       Refresh availability and status\n"
                "[b]Space[/b]   Select the highlighted session\n"
                "[b]Enter[/b]   Select or confirm\n"
                "[b]Ctrl+B[/b]  Booking view\n"
                "[b]Ctrl+O[/b]  My Dooremi bookings\n"
                "[b]Ctrl+J[/b]  Automation view\n"
                "[b]Ctrl+H[/b]  System health view\n"
                "[b]Ctrl+P[/b]  Open the command palette\n"
                "[b]?[/b]       Show this keyboard map\n"
                "[b]q[/b]       Quit\n\n"
                "Everything is also clickable. Colors are reinforced with text "
                "and symbols so the interface remains legible without color.",
                id="help-copy",
            )
            yield Button("Got it", id="help-close", variant="primary")

    def on_mount(self):
        self.query_one(Button).focus()

    def on_button_pressed(self, _event):
        self.dismiss()

    def action_close(self):
        self.dismiss()


class TennisBookerApp(App):
    """Responsive terminal control center."""

    TITLE = "Tennis Booker"
    SUB_TITLE = "local · secure · synchronized"

    CSS = """
    $ink: #f5efe6;
    $muted: #aaa095;
    $panel: #191715;
    $panel-hi: #24201d;
    $line: #3a332e;
    $purple: #ff8a65;
    $cyan: #f6c177;
    $gold: #d8b26e;
    $yellow: #e8a15b;
    $red: #ef6f6c;

    Screen {
        background: #100f0e;
        color: $ink;
    }

    #hero {
        height: 5;
        padding: 1 2 0 2;
        background: #151311;
        border-bottom: solid $line;
    }

    #brand {
        width: 1fr;
        content-align: left middle;
    }

    #wordmark {
        color: $purple;
        text-style: bold;
    }

    #tagline {
        color: $muted;
    }

    #status-strip {
        width: auto;
        height: 3;
        align: right middle;
    }

    .status-pill {
        width: auto;
        min-width: 13;
        height: 3;
        margin-left: 1;
        padding: 0 1;
        content-align: center middle;
        background: $panel;
        border: round $line;
    }

    .status-ok {
        color: $gold;
    }

    .status-warn {
        color: $yellow;
    }

    #main-tabs {
        height: 1fr;
        padding: 0 1;
    }

    ContentSwitcher {
        background: transparent;
    }

    TabbedContent > Tabs {
        height: 3;
        background: transparent;
        border-bottom: solid $line;
    }

    Tab {
        color: $muted;
        padding: 0 2;
    }

    Tab.-active {
        color: $ink;
        background: $panel-hi;
        text-style: bold;
    }

    Underline > .underline--bar {
        color: $purple;
    }

    TabPane {
        padding: 1;
    }

    #date-toolbar {
        height: 5;
        padding: 0 1;
        background: $panel;
        border: round $line;
        align-vertical: middle;
    }

    #date-back, #date-forward {
        min-width: 5;
        width: 5;
        margin-right: 1;
    }

    #date-forward {
        margin-left: 1;
    }

    #date-input {
        width: 18;
    }

    #date-context {
        width: 1fr;
        height: 3;
        padding-left: 2;
        content-align: left middle;
        color: $muted;
    }

    #refresh-availability {
        width: 13;
    }

    #booking-layout {
        height: 1fr;
        margin-top: 1;
        layout: horizontal;
    }

    .pane {
        height: 1fr;
        background: $panel;
        border: round $line;
    }

    #sessions-pane {
        width: 2fr;
        margin-right: 1;
    }

    #summary-pane {
        width: 1fr;
        min-width: 30;
    }

    .pane-heading {
        height: 3;
        padding: 1 2 0 2;
        color: $ink;
        text-style: bold;
    }

    .pane-subheading {
        height: 2;
        padding: 0 2;
        color: $muted;
    }

    DataTable {
        background: transparent;
        scrollbar-color: $line;
        scrollbar-color-hover: $purple;
        scrollbar-color-active: $cyan;
    }

    DataTable > .datatable--header {
        background: $panel-hi;
        color: $muted;
        text-style: bold;
    }

    DataTable > .datatable--cursor {
        background: #3a3029;
        color: $ink;
    }

    DataTable > .datatable--hover {
        background: #2d2722;
    }

    #slot-loading {
        height: 3;
        color: $purple;
        display: none;
    }

    #slots-grid {
        height: 1fr;
        padding: 0 1 1 1;
        layout: grid;
        grid-size: 4;
        grid-columns: 1fr 1fr 1fr 1fr;
        grid-rows: 4;
        grid-gutter: 0 1;
        overflow-y: auto;
    }

    .slot-button {
        width: 1fr;
        min-width: 0;
        height: 4;
        padding: 0;
        color: $ink;
        background: #211e1b;
        border: round $line;
        text-style: none;
    }

    .slot-button:hover, .slot-button:focus {
        background: #302923;
        border: round $purple;
    }

    .slot-button.slot-selected {
        color: #160f0b;
        background: $purple;
        border: round $purple;
        text-style: bold;
    }

    .slot-button:disabled {
        color: #766e67;
        background: #151311;
        border: round #2a2622;
        opacity: 100%;
    }

    #empty-state {
        height: 1fr;
        padding: 2;
        content-align: center middle;
        color: $muted;
        display: none;
    }

    #selection-card {
        margin: 1 2;
        padding: 1 2;
        min-height: 9;
        background: $panel-hi;
        border-left: thick $purple;
    }

    #selection-title {
        color: $purple;
        text-style: bold;
        margin-bottom: 1;
    }

    #selection-copy {
        color: $muted;
    }

    #primary-action {
        margin: 1 2;
        width: 1fr;
    }

    #selection-hint {
        height: auto;
        padding: 0 2 1 2;
        color: $muted;
    }

    #jobs-toolbar, #bookings-toolbar, #system-toolbar {
        height: 4;
        padding: 0 1;
        align-vertical: middle;
    }

    #jobs-toolbar Static, #bookings-toolbar Static, #system-toolbar Static {
        width: 1fr;
        content-align: left middle;
        color: $muted;
    }

    #jobs-table, #bookings-table {
        height: 1fr;
        border: round $line;
    }

    #job-detail, #booking-detail {
        height: 8;
        margin-top: 1;
        padding: 1 2;
        background: $panel;
        border: round $line;
        color: $muted;
    }

    #system-grid {
        height: 10;
        layout: horizontal;
    }

    .health-card {
        width: 1fr;
        height: 9;
        margin-right: 1;
        padding: 1 2;
        background: $panel;
        border: round $line;
    }

    .health-card:last-child {
        margin-right: 0;
    }

    .health-title {
        color: $muted;
        margin-bottom: 1;
    }

    .health-value {
        color: $ink;
        text-style: bold;
    }

    .health-note {
        color: $muted;
        margin-top: 1;
    }

    #log {
        height: 1fr;
        margin-top: 1;
        padding: 1;
        background: $panel;
        border: round $line;
        color: $muted;
    }

    Footer {
        background: #151311;
        color: $muted;
    }

    Button {
        min-width: 12;
        background: $panel-hi;
        color: $ink;
        border: tall $line;
    }

    Button:hover {
        background: #342c26;
        border: tall $purple;
    }

    Button.-primary {
        background: $purple;
        color: #160f0b;
    }

    Button.-success {
        background: $gold;
        color: #17100c;
    }

    Button.-error {
        background: $red;
        color: #14080a;
    }

    Input {
        background: #12100f;
        border: tall $line;
    }

    Input:focus {
        border: tall $purple;
    }

    ModalScreen {
        align: center middle;
        background: #090806cc;
    }

    #dialog, #setup-dialog, #help-dialog {
        width: 62;
        height: auto;
        max-height: 90%;
        padding: 1 2;
        background: $panel;
        border: round $purple;
    }

    #setup-dialog {
        width: 72;
    }

    #help-dialog {
        width: 60;
    }

    #dialog-title {
        height: 2;
        color: $ink;
        text-style: bold;
    }

    #dialog-body, .dialog-copy {
        height: auto;
        min-height: 4;
        color: $muted;
    }

    #dialog-actions {
        height: 4;
        margin-top: 1;
        align-horizontal: right;
    }

    #dialog-actions Button {
        margin-left: 1;
    }

    .field-label {
        height: 2;
        margin-top: 1;
        color: $muted;
    }

    .or-divider, .microcopy {
        height: 2;
        content-align: center middle;
        color: $muted;
    }

    .microcopy {
        content-align: left middle;
    }

    #help-copy {
        height: auto;
        min-height: 18;
        color: $muted;
    }

    #help-close {
        width: 100%;
        margin-top: 1;
    }

    .compact .status-pill {
        margin-left: 0;
        margin-right: 1;
        min-width: 11;
    }

    .compact #date-toolbar {
        height: 5;
        layout: horizontal;
    }

    .compact #date-context {
        display: none;
    }

    .compact #refresh-availability {
        width: 1fr;
        min-width: 10;
    }

    .compact #booking-layout {
        layout: vertical;
    }

    .compact #slots-grid {
        grid-size: 3;
        grid-columns: 1fr 1fr 1fr;
    }

    .compact #sessions-pane {
        width: 100%;
        height: 2fr;
        margin-right: 0;
        margin-bottom: 1;
    }

    .compact #summary-pane {
        width: 100%;
        min-width: 0;
        height: 1fr;
    }

    .compact #system-grid {
        height: auto;
        layout: vertical;
    }

    .compact .health-card {
        width: 100%;
        height: 7;
        margin-right: 0;
        margin-bottom: 1;
    }

    .tiny #hero {
        height: 8;
        layout: vertical;
    }

    .tiny #brand {
        height: 3;
    }

    .tiny #status-strip {
        width: 100%;
        align: left middle;
    }

    .tiny #tagline, .tiny #status-power, .tiny #date-context {
        display: none;
    }

    .tiny #status-token, .tiny #status-agent {
        width: 1fr;
    }

    .tiny #slots-grid {
        grid-size: 2;
        grid-columns: 1fr 1fr;
    }

    .tiny #dialog, .tiny #setup-dialog, .tiny #help-dialog {
        width: 94%;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("r", "refresh", "Refresh"),
        Binding("left", "previous_date", "Previous date"),
        Binding("right", "next_date", "Next date"),
        Binding("space", "toggle_session", "Select"),
        Binding("enter", "activate", "Open", show=False),
        Binding("ctrl+b", "show_booking", "Book", show=False),
        Binding("ctrl+o", "show_my_bookings", "My bookings", show=False),
        Binding("ctrl+j", "show_jobs", "Schedules", show=False),
        Binding("ctrl+h", "show_system", "System", show=False),
        Binding("question_mark", "help", "Help"),
    ]

    def __init__(self, cli=None, auto_load=True):
        super().__init__()
        self.cli = cli or core.CLI()
        self.auto_load = auto_load
        self.event_day = (
            core.now_sgt().date()
            + dt.timedelta(days=self.cli.store.load_config().booking_lead_days)
        )
        self.availability = None
        self.selected_times = []
        self.selected_job_id = None
        self.jobs_by_id = {}
        self.selected_booking_id = None
        self.bookings_by_id = {}
        self._loading_availability = False
        self._availability_request_id = 0
        self._auth_invalid = False

    def compose(self) -> ComposeResult:
        with Horizontal(id="hero"):
            with Vertical(id="brand"):
                yield Static("●  TENNIS BOOKER", id="wordmark")
                yield Static(
                    "Fast at noon. Calm the rest of the time.",
                    id="tagline",
                )
            with Horizontal(id="status-strip"):
                yield Static("○  Token", id="status-token", classes="status-pill")
                yield Static("○  Agent", id="status-agent", classes="status-pill")
                yield Static("○  Power", id="status-power", classes="status-pill")

        with TabbedContent(id="main-tabs", initial="book-tab"):
            with TabPane("Book a court", id="book-tab"):
                with Horizontal(id="date-toolbar"):
                    yield Button("←", id="date-back", tooltip="Previous date")
                    yield Input(id="date-input", placeholder="YYYY-MM-DD")
                    yield Button("→", id="date-forward", tooltip="Next date")
                    yield Static("", id="date-context")
                    yield Button("Refresh", id="refresh-availability")

                with Container(id="booking-layout"):
                    with Vertical(id="sessions-pane", classes="pane"):
                        yield Static("Available sessions", classes="pane-heading")
                        yield Static(
                            "Choose up to six · every time remains visible",
                            id="sessions-caption",
                            classes="pane-subheading",
                        )
                        yield LoadingIndicator(id="slot-loading")
                        yield Grid(id="slots-grid")
                        yield Static(
                            "Choose a date to see live court availability.",
                            id="empty-state",
                        )

                    with VerticalScroll(id="summary-pane", classes="pane"):
                        yield Static("Your selection", classes="pane-heading")
                        with Container(id="selection-card"):
                            yield Static("Nothing selected", id="selection-title")
                            yield Static(
                                "Choose up to six available session tiles.",
                                id="selection-copy",
                            )
                        yield Button(
                            "Select a session",
                            id="primary-action",
                            variant="primary",
                            disabled=True,
                        )
                        yield Static(
                            "No request is sent until you confirm. Future sessions "
                            "are scheduled for their opening time.",
                            id="selection-hint",
                        )

            with TabPane("My bookings", id="bookings-tab"):
                with Horizontal(id="bookings-toolbar"):
                    yield Static("Confirmed and previous Dooremi bookings")
                    yield Button(
                        "Cancel booking",
                        id="cancel-booking",
                        disabled=True,
                        variant="error",
                    )
                    yield Button("Refresh", id="refresh-bookings")
                yield DataTable(
                    id="bookings-table",
                    cursor_type="row",
                    zebra_stripes=True,
                )
                yield Static(
                    "Select a booking to see its details.",
                    id="booking-detail",
                )

            with TabPane("Automation", id="jobs-tab"):
                with Horizontal(id="jobs-toolbar"):
                    yield Static("Upcoming attempts and booking history")
                    yield Button("Cancel selected", id="cancel-job", disabled=True)
                    yield Button("Refresh", id="refresh-jobs")
                yield DataTable(
                    id="jobs-table",
                    cursor_type="row",
                    zebra_stripes=True,
                )
                yield Static(
                    "Select a schedule to see its details.",
                    id="job-detail",
                )

            with TabPane("System", id="system-tab"):
                with Horizontal(id="system-toolbar"):
                    yield Static("Unattended booking readiness")
                    yield Button("Connect", id="setup", variant="primary")
                    yield Button("Run checks", id="run-checks")
                with Container(id="system-grid"):
                    with Vertical(classes="health-card"):
                        yield Static("AUTHENTICATION", classes="health-title")
                        yield Static("Checking…", id="health-token", classes="health-value")
                        yield Static("", id="health-token-note", classes="health-note")
                    with Vertical(classes="health-card"):
                        yield Static("BACKGROUND AGENT", classes="health-title")
                        yield Static("Checking…", id="health-agent", classes="health-value")
                        yield Static("", id="health-agent-note", classes="health-note")
                    with Vertical(classes="health-card"):
                        yield Static("POWER", classes="health-title")
                        yield Static("Checking…", id="health-power", classes="health-value")
                        yield Static("", id="health-power-note", classes="health-note")
                    with Vertical(classes="health-card"):
                        yield Static("RELEASE TIMING", classes="health-title")
                        yield Static("Checking…", id="health-timing", classes="health-value")
                        yield Static("", id="health-timing-note", classes="health-note")
                yield RichLog(id="log", wrap=True, markup=True)

        yield Footer()

    def on_mount(self):
        self._configure_tables()
        self._sync_date_controls()
        self._apply_responsive_classes(self.size.width)
        self.refresh_status()
        self.set_interval(3, self.refresh_power_status)
        self.refresh_jobs()
        if self.auto_load:
            if self.cli.keychain.exists():
                self.load_availability()
                self.load_bookings()
            else:
                self._show_disconnected_state()
                self.notify(
                    "Connect your Dooremi session to load live availability.",
                    title="One-time setup",
                    severity="warning",
                    timeout=8,
                )

    def _configure_tables(self):
        bookings = self.query_one("#bookings-table", DataTable)
        bookings.add_columns("", "Facility", "Date", "Time", "Status")
        bookings.fixed_columns = 1

        jobs = self.query_one("#jobs-table", DataTable)
        jobs.add_columns("", "Session date", "Time", "Attempt", "Result")
        jobs.fixed_columns = 1

    def on_resize(self, event: Resize):
        self._apply_responsive_classes(event.size.width)

    def _apply_responsive_classes(self, width):
        self.screen.set_class(width < 72, "compact")
        self.screen.set_class(width < 52, "tiny")

    def _sync_date_controls(self):
        self.query_one("#date-input", Input).value = self.event_day.isoformat()
        config = self.cli.store.load_config()
        self.query_one("#date-context", Static).update(
            "{}  ·  {}".format(
                relative_day(self.event_day),
                release_summary(self.event_day.isoformat(), config),
            )
        )

    def refresh_status(self):
        token = self.cli.keychain.exists() and not self._auth_invalid
        agent_file = self.cli.agent.installed()
        agent_loaded = False
        if agent_file:
            with contextlib.suppress(Exception):
                output = self.cli.agent.status()
                agent_loaded = core.AGENT_LABEL in output
        self._set_status_pill("#status-token", token, "Token")
        self._set_status_pill("#status-agent", agent_loaded, "Agent")
        self.refresh_power_status()

        self.query_one("#health-token", Static).update(
            "Ready" if token else "Needs attention"
        )
        self.query_one("#health-token-note", Static).update(
            "Long-lived session token stored in macOS Keychain."
            if token
            else "Import a fresh HAR or Bearer token."
        )
        self.query_one("#health-agent", Static).update(
            "Loaded" if agent_loaded else "Not loaded"
        )
        self.query_one("#health-agent-note", Static).update(
            (
                "launchd checks every 30s · closed-lid wake test passed."
                if self.cli.paths.wake_result.exists()
                else "launchd checks every 30s · wake test not yet verified."
            )
            if agent_loaded
            else "Connect again to install the background agent."
        )
        fire_delay = self.cli.store.load_config().fire_delay_milliseconds
        self.query_one("#health-timing", Static).update(
            "+{} ms".format(fire_delay)
        )
        self.query_one("#health-timing-note", Static).update(
            "Persistent HTTPS is primed twice before release."
        )
        self._refresh_log()

    def refresh_power_status(self):
        power = core.mac_power_state()
        connected = power["external_connected"]
        label = "Power" if connected else "Cable" if power["cable_detected"] else "Battery"
        self._set_status_pill("#status-power", connected, label)
        if connected:
            value = "Charging" if power["charging"] else "AC connected"
            note = "Safe for a scheduled wake."
        elif power["cable_detected"]:
            value = "Cable · no power"
            note = "A port sees a cable, but macOS reports Battery Power."
        else:
            value = "On battery"
            note = "Connect a powered charger before closing the lid."
        if power["percent"] is not None:
            value += " · {}%".format(power["percent"])
        self.query_one("#health-power", Static).update(value)
        self.query_one("#health-power-note", Static).update(note)

    def _set_status_pill(self, selector, okay, label):
        widget = self.query_one(selector, Static)
        widget.update("{}  {}".format("●" if okay else "○", label))
        widget.set_class(okay, "status-ok")
        widget.set_class(not okay, "status-warn")

    def _refresh_log(self):
        log = self.query_one("#log", RichLog)
        log.clear()
        if not self.cli.paths.runner_log.exists():
            log.write("[dim]No runner activity yet.[/dim]")
            return
        lines = self.cli.paths.runner_log.read_text(
            "utf-8", errors="replace"
        ).splitlines()
        for line in lines[-18:]:
            color = "orange1" if "success" in line else "red" if "failed" in line else "dim"
            log.write("[{}]{}[/{}]".format(color, line, color))

    def _show_disconnected_state(self):
        self.query_one("#slots-grid", Grid).display = False
        empty = self.query_one("#empty-state", Static)
        empty.display = True
        empty.update(
            "Live availability is waiting for a Dooremi connection.\n\n"
            "Open System → Connect to complete one-time setup."
        )

    def load_availability(self):
        if not self.cli.keychain.exists():
            self._show_disconnected_state()
            self.action_show_system()
            return
        self._loading_availability = True
        self._availability_request_id += 1
        request_id = self._availability_request_id
        requested_day = self.event_day.isoformat()
        self.selected_times = []
        self._update_selection()
        grid = self.query_one("#slots-grid", Grid)
        existing_buttons = list(grid.query(SlotButton))
        for button in existing_buttons:
            button.disabled = True
        self.query_one("#slot-loading", LoadingIndicator).display = not bool(
            existing_buttons
        )
        grid.display = bool(existing_buttons)
        self.query_one("#sessions-caption", Static).update(
            "Loading {} · previous tiles are temporarily disabled".format(
                requested_day
            )
        )
        self.query_one("#empty-state", Static).display = False
        self.query_one("#refresh-availability", Button).label = "Loading…"
        self.run_worker(
            lambda: self._fetch_availability(request_id, requested_day),
            name="Live availability",
            group="availability",
            exclusive=True,
            thread=True,
            exit_on_error=False,
        )

    def _fetch_availability(self, request_id, event_day):
        try:
            config = self.cli.store.load_config()
            result = self.cli.client.availability(
                event_day,
                config.facility_id,
                config.facility_category_id,
                self.cli.keychain.load(),
            )
        except Exception as error:
            self.call_from_thread(
                self._availability_failed,
                request_id,
                error,
            )
        else:
            self.call_from_thread(
                self._availability_loaded,
                request_id,
                event_day,
                result,
            )

    async def _availability_loaded(self, request_id, event_day, result):
        if request_id != self._availability_request_id:
            return
        self._loading_availability = False
        self._auth_invalid = False
        self.availability = result
        self.query_one("#slot-loading", LoadingIndicator).display = False
        self.query_one("#refresh-availability", Button).label = "Refresh"
        grid = self.query_one("#slots-grid", Grid)
        buttons = list(grid.query(SlotButton))
        if len(buttons) != len(result["slots"]):
            await grid.remove_children()
            buttons = [
                SlotButton(slot, index)
                for index, slot in enumerate(result["slots"])
            ]
            if buttons:
                await grid.mount(*buttons)
        else:
            for button, slot in zip(buttons, result["slots"]):
                button.slot = slot
                button.disabled = not slot["available"]
        self._render_slots()
        grid.display = bool(result["slots"])
        self.query_one("#sessions-caption", Static).update(
            "Choose up to {} · every time remains visible".format(
                self.cli.store.load_config().max_sessions_per_booking
            )
        )
        empty = self.query_one("#empty-state", Static)
        empty.display = not result["slots"]
        if not result["slots"]:
            empty.update("No sessions were returned for this date.")
        available_count = len(
            [slot for slot in result["slots"] if slot["available"]]
        )
        self.notify(
            "{} available session{} for {}.".format(
                available_count,
                "" if available_count == 1 else "s",
                relative_day(self.event_day).lower(),
            ),
            title=result["facility_name"],
            timeout=4,
        )
        if available_count:
            focus_target = next(
                (
                    button
                    for button in buttons
                    if not button.disabled
                ),
                None,
            )
            if focus_target is not None:
                focus_target.focus()

    def _availability_failed(self, request_id, error):
        if request_id != self._availability_request_id:
            return
        self._loading_availability = False
        self.availability = None
        if isinstance(error, core.AuthenticationError):
            self._auth_invalid = True
            self.refresh_status()
        self.query_one("#slot-loading", LoadingIndicator).display = False
        self.query_one("#refresh-availability", Button).label = "Retry"
        self.query_one("#slots-grid", Grid).display = False
        self.query_one("#sessions-caption", Static).update(
            "Could not load {}".format(self.event_day.isoformat())
        )
        empty = self.query_one("#empty-state", Static)
        empty.display = True
        message = core.safe_message(error)
        empty.update(
            "Availability could not be loaded.\n\n{}\n\nPress R to try again.".format(
                message
            )
        )
        title = (
            "Dooremi session expired"
            if isinstance(error, core.AuthenticationError)
            else "Dooremi timed out"
            if isinstance(error, core.NetworkTimeoutError)
            else "Could not load availability"
        )
        self.notify(message, title=title, severity="error")

    def load_bookings(self):
        if not self.cli.keychain.exists():
            return
        self.query_one("#refresh-bookings", Button).disabled = True
        self.run_worker(
            self._fetch_bookings,
            name="Dooremi bookings",
            group="bookings",
            exclusive=True,
            thread=True,
            exit_on_error=False,
        )

    def _fetch_bookings(self):
        try:
            bookings = self.cli.client.booking_history(
                self.cli.keychain.load(),
                page_size=15,
            )
        except Exception as error:
            self.call_from_thread(
                self._bookings_failed,
                error,
            )
        else:
            self.call_from_thread(self._bookings_loaded, bookings)

    def _bookings_loaded(self, bookings):
        self._auth_invalid = False
        self.query_one("#refresh-bookings", Button).disabled = False
        self.bookings_by_id = {
            str(booking["id"]): booking for booking in bookings
        }
        table = self.query_one("#bookings-table", DataTable)
        table.clear()
        for booking in bookings:
            confirmed = booking["status_name"] == "Confirmed"
            table.add_row(
                Text("●" if confirmed else "○", style="orange1" if confirmed else "grey50"),
                booking["facility_name"],
                booking["event_day"],
                booking["event_time"],
                Text(
                    booking["status_name"],
                    style="orange1" if confirmed else "grey50",
                ),
                key=str(booking["id"]),
            )
        if not bookings:
            self.query_one("#booking-detail", Static).update(
                "No Dooremi bookings were returned."
            )
        self.selected_booking_id = None
        self.query_one("#cancel-booking", Button).disabled = True

    def _bookings_failed(self, error):
        self.query_one("#refresh-bookings", Button).disabled = False
        if isinstance(error, core.AuthenticationError):
            self._auth_invalid = True
            self.refresh_status()
        message = core.safe_message(error)
        self.notify(
            message,
            title=(
                "Dooremi session expired"
                if isinstance(error, core.AuthenticationError)
                else "Dooremi timed out"
                if isinstance(error, core.NetworkTimeoutError)
                else "Could not load bookings"
            ),
            severity="error",
        )

    def _select_booking(self, booking_id):
        booking = self.bookings_by_id.get(str(booking_id))
        if not booking:
            return
        self.selected_booking_id = str(booking_id)
        self.query_one("#booking-detail", Static).update(
            "[b]{} · {}[/b]\n"
            "{}\n"
            "Status: {}    Booking ID: {}\n"
            "{}".format(
                booking["event_day"],
                booking["event_time"],
                booking["facility_name"],
                booking["status_name"],
                booking["id"],
                "This booking can be cancelled."
                if booking["can_cancel"]
                else "Dooremi does not allow cancellation for this booking.",
            )
        )
        self.query_one("#cancel-booking", Button).disabled = not booking[
            "can_cancel"
        ]

    def refresh_jobs(self):
        jobs = self.cli.store.load_schedules()
        self.jobs_by_id = {job["id"]: job for job in jobs}
        table = self.query_one("#jobs-table", DataTable)
        table.clear()
        status_styles = {
            "pending": ("○", "gold1"),
            "running": ("◉", "orange1"),
            "succeeded": ("●", "orange1"),
            "partial": ("◐", "yellow"),
            "failed": ("●", "red"),
            "missed": ("●", "red"),
            "cancelled": ("○", "bright_black"),
        }
        for job in sorted(jobs, key=lambda item: item["release_at"], reverse=True):
            marker, style = status_styles.get(job.get("status"), ("?", "white"))
            release = dt.datetime.fromisoformat(job["release_at"])
            result = job.get("result_message") or job.get("status", "unknown").title()
            table.add_row(
                Text(marker, style=style),
                job["event_day"],
                job["event_time"],
                release.strftime("%-d %b · %H:%M"),
                Text(result, style=style),
                key=job["id"],
            )
        if not jobs:
            self.query_one("#job-detail", Static).update(
                "No schedules yet.\n\nSelect an available future session to create one."
            )
        self.selected_job_id = None
        self.query_one("#cancel-job", Button).disabled = True

    def _slot_for_time(self, event_time):
        if not self.availability:
            return None
        return next(
            (
                slot
                for slot in self.availability["slots"]
                if slot["event_time"] == event_time
            ),
            None,
        )

    def _toggle_time(self, event_time):
        slot = self._slot_for_time(event_time)
        if not slot or not slot["available"]:
            self.notify(
                "That session is already booked.",
                title="Choose an available time",
                severity="warning",
            )
            return
        if event_time in self.selected_times:
            self.selected_times.remove(event_time)
        else:
            maximum = self.cli.store.load_config().max_sessions_per_booking
            if len(self.selected_times) >= maximum:
                self.notify(
                    "You can choose at most {} sessions.".format(maximum),
                    title="Selection limit",
                    severity="warning",
                )
                return
            self.selected_times.append(event_time)
        self._render_slots()
        self._update_selection()

    def _render_slots(self):
        if not self.availability:
            return
        for button in self.query(SlotButton):
            event_time = button.slot["event_time"]
            selected = event_time in self.selected_times
            if selected:
                priority = self.selected_times.index(event_time) + 1
                button.label = "{}  {}\nSelected".format(priority, event_time)
            else:
                button.label = "{}\n{}".format(
                    event_time,
                    "Available" if button.slot["available"] else "Booked",
                )
            button.set_class(selected, "slot-selected")

    def _update_selection(self):
        title = self.query_one("#selection-title", Static)
        copy = self.query_one("#selection-copy", Static)
        action = self.query_one("#primary-action", Button)
        if not self.selected_times:
            title.update("Nothing selected")
            copy.update(
                "Choose up to {} available session tiles.".format(
                    self.cli.store.load_config().max_sessions_per_booking
                )
            )
            action.label = "Select a session"
            action.disabled = True
            return
        config = self.cli.store.load_config()
        release = core.release_at(self.event_day.isoformat(), config)
        immediate = release <= core.now_sgt()
        title.update(
            "{} session{} selected".format(
                len(self.selected_times),
                "" if len(self.selected_times) == 1 else "s",
            )
        )
        copy.update(
            "{}\n{}\n{}\n\n{}".format(
                self.availability["facility_name"],
                relative_day(self.event_day),
                "  ·  ".join(self.selected_times),
                "Books after a final confirmation."
                if immediate
                else "Will wake the Mac and attempt once at opening.",
            )
        )
        action.label = "Review booking" if immediate else "Review schedule"
        action.disabled = False

    def on_data_table_row_selected(self, event):
        if event.data_table.id == "jobs-table":
            self._select_job(event.row_key.value)
        elif event.data_table.id == "bookings-table":
            self._select_booking(event.row_key.value)

    def on_data_table_row_highlighted(self, event):
        if event.data_table.id == "jobs-table":
            self._select_job(event.row_key.value)
        elif event.data_table.id == "bookings-table":
            self._select_booking(event.row_key.value)

    def _select_job(self, schedule_id):
        job = self.jobs_by_id.get(schedule_id)
        if not job:
            return
        self.selected_job_id = schedule_id
        release = dt.datetime.fromisoformat(job["release_at"])
        detail = (
            "[b]{} · {}[/b]\n"
            "Attempt: {} SGT\n"
            "Status: {}    ID: {}\n"
            "{}"
        ).format(
            job["event_day"],
            job["event_time"],
            core.display_datetime(release),
            job.get("status", "unknown").title(),
            job["id"],
            job.get("result_message") or "No result yet.",
        )
        self.query_one("#job-detail", Static).update(detail)
        self.query_one("#cancel-job", Button).disabled = (
            job.get("status") not in ("pending", "running")
        )

    def on_input_submitted(self, event):
        if event.input.id != "date-input":
            return
        try:
            self.event_day = core.parse_event_day(event.value.strip())
        except core.BookerError as error:
            self.notify(str(error), title="Invalid date", severity="error")
            self._sync_date_controls()
            return
        self._sync_date_controls()
        self.load_availability()

    def on_button_pressed(self, event):
        if isinstance(event.button, SlotButton):
            self._toggle_time(event.button.slot["event_time"])
            return
        button_id = event.button.id
        if button_id == "date-back":
            self.action_previous_date()
        elif button_id == "date-forward":
            self.action_next_date()
        elif button_id == "refresh-availability":
            self.load_availability()
        elif button_id == "primary-action":
            self._review_selection()
        elif button_id == "refresh-jobs":
            self.refresh_jobs()
        elif button_id == "refresh-bookings":
            self.load_bookings()
        elif button_id == "cancel-booking":
            self._review_booking_cancel()
        elif button_id == "cancel-job":
            self._review_cancel()
        elif button_id in ("setup",):
            self.push_screen(SetupScreen(), self._complete_setup)
        elif button_id == "run-checks":
            self.refresh_status()
            self.notify("System checks refreshed.", title="Health check")

    def _review_selection(self):
        if not self.selected_times:
            return
        config = self.cli.store.load_config()
        release = core.release_at(self.event_day.isoformat(), config)
        immediate = release <= core.now_sgt()
        request_count = len(self.selected_times)
        request_description = (
            "{} single-slot requests · synchronized release · no retries".format(
                request_count
            )
            if request_count > 1
            else "One single-slot request · no retries"
        )
        active_bookings = [
            booking
            for booking in self.bookings_by_id.values()
            if booking.get("status_name") == "Confirmed"
            and "tennis" in booking.get("facility_name", "").casefold()
        ]
        active_session_count = sum(
            len(booking.get("event_times") or [])
            for booking in active_bookings
        )
        has_confirmed_booking = bool(active_bookings)
        existing_booking_warning = (
            "\n\n[yellow]Automatic rebooking: {} active tennis session{} "
            "will be cancelled, verified, and submitted again alongside this "
            "selection. The transaction stops before submission if cancellation "
            "cannot be verified.[/yellow]".format(
                active_session_count,
                "" if active_session_count == 1 else "s",
            )
            if has_confirmed_booking
            else "\n\n[dim]No active tennis bookings need to be preserved.[/dim]"
        )
        if active_session_count + request_count > config.max_sessions_per_booking:
            self.notify(
                "{} active plus {} selected sessions exceeds the six-session "
                "transaction limit.".format(active_session_count, request_count),
                title="Too many sessions",
                severity="error",
                timeout=8,
            )
            return
        if immediate:
            self._show_immediate_confirmation()
            return
        body = (
            "[b]{}[/b]\n"
            "{} · {}\n\n"
            "Attempt: {} SGT\n"
            "{}\n\n"
            "The Mac wakes 3 minutes early, holds itself awake, primes "
            "one HTTPS connection per session, then submits at the opening "
            "boundary.{}\n\n"
            "[dim]macOS may request an administrator password to install "
            "the hardware wake event. Keep the Mac logged in, sleeping "
            "(not shut down), connected to real AC power and Wi-Fi.[/dim]"
        ).format(
            self.availability["facility_name"],
            self.event_day.isoformat(),
            " · ".join(self.selected_times),
            core.display_datetime(release),
            request_description,
            existing_booking_warning,
        )
        self.push_screen(
            ConfirmScreen("Schedule rebooking transaction?", body, "Schedule"),
            self._schedule_confirmed,
        )

    def _show_immediate_confirmation(self):
        schedule = core.new_schedule(
            self.event_day.isoformat(),
            self.selected_times,
            self.cli.store.load_config(),
            "running",
        )
        request_count = len(core.schedule_event_times(schedule))
        request_description = (
            "This sends {} independent single-slot requests together using "
            "Dooremi’s temporary workaround.".format(request_count)
            if request_count > 1
            else "This sends one real booking request immediately."
        )
        active_bookings = [
            booking
            for booking in self.bookings_by_id.values()
            if booking.get("status_name") == "Confirmed"
            and "tennis" in booking.get("facility_name", "").casefold()
        ]
        active_session_count = sum(
            len(booking.get("event_times") or [])
            for booking in active_bookings
        )
        existing_booking_warning = (
            "\n\n[yellow]Automatic rebooking: {} active tennis session{} will "
            "be cancelled now, verified, then re-submitted with your selection."
            "[/yellow]".format(
                active_session_count,
                "" if active_session_count == 1 else "s",
            )
            if active_bookings
            else ""
        )
        body = (
            "[b]{}[/b]\n"
            "{} · {}\n\n"
            "{}\n"
            "The result will be recorded in Schedules.{}"
        ).format(
            self.availability["facility_name"],
            schedule["event_day"],
            " · ".join(core.schedule_event_times(schedule)),
            request_description,
            existing_booking_warning,
        )
        self.push_screen(
            ConfirmScreen(
                "Confirm booking",
                body,
                "Book now",
                danger=True,
            ),
            lambda confirmed: self._book_confirmed(confirmed, schedule),
        )

    def _book_confirmed(self, confirmed, schedule):
        if not confirmed:
            return
        request_count = len(core.schedule_event_times(schedule))
        self.notify(
            "Cancelling active bookings, then releasing {} synchronized "
            "request{}…".format(
                request_count,
                "" if request_count == 1 else "s",
            ),
            title="Booking",
        )
        self.run_worker(
            lambda: self._create_booking(schedule),
            name="Create booking",
            group="booking",
            exclusive=True,
            thread=True,
            exit_on_error=False,
        )

    def _create_booking(self, schedule):
        try:
            self.cli.store.add_schedule(schedule)
            result = self.cli.client.create_booking(
                schedule, self.cli.keychain.load()
            )
            schedule["status"] = "succeeded"
            schedule["attempted_at"] = core.now_sgt().isoformat()
            schedule["result_message"] = result["message"]
            schedule["booking_order_id"] = result["booking_order_id"]
            schedule["booking_order_ids"] = result["booking_order_ids"]
            schedule["submitted_targets"] = result["booking_targets"]
            schedule["cancelled_booking_ids"] = result[
                "cancelled_booking_ids"
            ]
            self.cli.store.update_schedule(schedule)
        except core.PartialBookingError as error:
            schedule["status"] = "partial"
            schedule["attempted_at"] = core.now_sgt().isoformat()
            schedule["result_message"] = core.safe_message(error)
            schedule["booking_order_ids"] = error.booking_order_ids
            schedule["booking_order_id"] = (
                error.booking_order_ids[0] if error.booking_order_ids else None
            )
            schedule["submitted_targets"] = schedule.get(
                "prepared_targets", []
            )
            with contextlib.suppress(Exception):
                self.cli.store.update_schedule(schedule)
            self.call_from_thread(
                self._booking_finished,
                "partial",
                core.safe_message(error),
            )
            return
        except Exception as error:
            schedule["status"] = "failed"
            schedule["attempted_at"] = core.now_sgt().isoformat()
            schedule["result_message"] = core.safe_message(error)
            with contextlib.suppress(Exception):
                self.cli.store.update_schedule(schedule)
            self.call_from_thread(
                self._booking_finished,
                "failed",
                core.safe_message(error),
            )
            return
        self.call_from_thread(
            self._booking_finished, "succeeded", result["message"]
        )

    def _booking_finished(self, status, message):
        self.refresh_jobs()
        self.load_availability()
        self.set_timer(0.8, self.load_bookings)
        success = status == "succeeded"
        partial = status == "partial"
        self.notify(
            message,
            title=(
                "Booking confirmed"
                if success
                else "Booking outcome needs review"
                if partial
                else "Booking failed"
            ),
            severity="information" if success else "warning" if partial else "error",
            timeout=10,
        )
        if success:
            self.bell()

    def _schedule_confirmed(self, confirmed):
        if not confirmed:
            return
        event_day = self.event_day.isoformat()
        event_times = list(self.selected_times)
        try:
            output = io.StringIO()
            with self.suspend():
                print(
                    "\nInstalling the scheduled wake. "
                    "Enter your macOS password if prompted.\n"
                )
                with contextlib.redirect_stdout(output):
                    schedule = self.cli.create_schedule(
                        event_day,
                        event_times,
                        self.cli.store.load_config(),
                    )
        except Exception as error:
            self.notify(
                core.safe_message(error),
                title="Could not create schedule",
                severity="error",
                timeout=10,
            )
            return
        self.refresh_jobs()
        self.refresh_status()
        self.selected_times = []
        self._render_slots()
        self._update_selection()
        self.notify(
            "{} · {} will be attempted at opening.".format(
                schedule["event_day"], schedule["event_time"]
            ),
            title="Schedule ready",
            timeout=8,
        )

    def _review_booking_cancel(self):
        booking = self.bookings_by_id.get(str(self.selected_booking_id))
        if not booking:
            return
        if not booking["can_cancel"]:
            self.notify(
                "Dooremi says this booking can no longer be cancelled.",
                severity="warning",
            )
            return
        body = (
            "[b]{}[/b]\n"
            "{} · {}\n\n"
            "This cancels the confirmed Dooremi booking and releases "
            "the court for other residents."
        ).format(
            booking["facility_name"],
            booking["event_day"],
            booking["event_time"],
        )
        self.push_screen(
            ConfirmScreen(
                "Cancel confirmed booking?",
                body,
                "Cancel booking",
                danger=True,
            ),
            self._booking_cancel_confirmed,
        )

    def _booking_cancel_confirmed(self, confirmed):
        if not confirmed or not self.selected_booking_id:
            return
        booking_id = int(self.selected_booking_id)
        self.notify("Sending cancellation…", title="Dooremi")
        self.run_worker(
            lambda: self._cancel_remote_booking(booking_id),
            name="Cancel Dooremi booking",
            group="cancel-booking",
            exclusive=True,
            thread=True,
            exit_on_error=False,
        )

    def _cancel_remote_booking(self, booking_id):
        try:
            result = self.cli.client.cancel_booking(
                booking_id,
                self.cli.keychain.load(),
            )
            bookings = []
            for delay in (0.25, 0.75, 1.5):
                time.sleep(delay)
                bookings = self.cli.client.booking_history(
                    self.cli.keychain.load(),
                    page_size=15,
                )
                current = next(
                    (
                        booking
                        for booking in bookings
                        if booking["id"] == booking_id
                    ),
                    None,
                )
                if current is None or current["status_name"] != "Confirmed":
                    break
        except Exception as error:
            self.call_from_thread(
                self.notify,
                core.safe_message(error),
                title="Cancellation failed",
                severity="error",
                timeout=10,
            )
            return
        self.call_from_thread(
            self._remote_booking_cancelled,
            result["message"],
            bookings,
        )

    def _remote_booking_cancelled(self, message, bookings):
        self.notify(
            message,
            title="Booking cancelled",
            timeout=8,
        )
        self._bookings_loaded(bookings)
        self.set_timer(0.5, self.load_availability)

    def _review_cancel(self):
        job = self.jobs_by_id.get(self.selected_job_id)
        if not job:
            return
        body = (
            "[b]{} · {}[/b]\n\n"
            "This cancels the local booking attempt. "
            "It does not cancel an existing Dooremi booking."
        ).format(job["event_day"], job["event_time"])
        self.push_screen(
            ConfirmScreen("Cancel this schedule?", body, "Cancel schedule", danger=True),
            self._cancel_confirmed,
        )

    def _cancel_confirmed(self, confirmed):
        if not confirmed or not self.selected_job_id:
            return
        try:
            job = self.cli.store.cancel_schedule(self.selected_job_id)
        except Exception as error:
            self.notify(core.safe_message(error), severity="error")
            return
        self.refresh_jobs()
        self.notify(
            "{} · {} was cancelled.".format(job["event_day"], job["event_time"]),
            title="Schedule cancelled",
        )

    def _complete_setup(self, values):
        if not values:
            return
        self.notify("Saving securely to macOS Keychain…", title="Connecting")
        self.run_worker(
            lambda: self._perform_setup(values),
            name="Secure setup",
            group="setup",
            exclusive=True,
            thread=True,
            exit_on_error=False,
        )

    def _perform_setup(self, values):
        try:
            if values["har"]:
                self.cli.keychain.import_har(str(Path(values["har"]).expanduser()))
            else:
                self.cli.keychain.save(values["token"])
            agent_ready = False
            if self.cli.agent.installed():
                with contextlib.suppress(Exception):
                    agent_ready = (
                        core.AGENT_LABEL in self.cli.agent.status()
                    )
            if not agent_ready:
                self.cli.agent.install()
            result = self.cli.client.warmup(self.cli.keychain.load())
        except Exception as error:
            self.call_from_thread(
                self.notify,
                core.safe_message(error),
                title="Connection failed",
                severity="error",
                timeout=10,
            )
            return
        self.call_from_thread(self._setup_finished, result["elapsed_ms"])

    def _setup_finished(self, elapsed_ms):
        self._auth_invalid = False
        self.refresh_status()
        self.notify(
            "Dooremi responded in {} ms.".format(elapsed_ms),
            title="Connected securely",
            timeout=6,
        )
        self.action_show_booking()
        self.load_availability()
        self.load_bookings()

    def action_refresh(self):
        self.refresh_status()
        self.refresh_jobs()
        active = self.query_one("#main-tabs", TabbedContent).active
        if active == "book-tab":
            self.load_availability()
        elif active == "bookings-tab":
            self.load_bookings()
        else:
            self.notify("Status refreshed.", timeout=2)

    def action_previous_date(self):
        self.event_day -= dt.timedelta(days=1)
        self._sync_date_controls()
        self.load_availability()

    def action_next_date(self):
        self.event_day += dt.timedelta(days=1)
        self._sync_date_controls()
        self.load_availability()

    def action_toggle_session(self):
        focused = self.focused
        if isinstance(focused, SlotButton):
            self._toggle_time(focused.slot["event_time"])

    def action_activate(self):
        focused = self.focused
        if isinstance(focused, SlotButton):
            self._toggle_time(focused.slot["event_time"])
        elif focused and focused.id == "primary-action":
            self._review_selection()

    def action_show_booking(self):
        self.query_one("#main-tabs", TabbedContent).active = "book-tab"

    def action_show_jobs(self):
        self.query_one("#main-tabs", TabbedContent).active = "jobs-tab"
        self.refresh_jobs()

    def action_show_my_bookings(self):
        self.query_one("#main-tabs", TabbedContent).active = "bookings-tab"
        self.load_bookings()

    def action_show_system(self):
        self.query_one("#main-tabs", TabbedContent).active = "system-tab"
        self.refresh_status()

    def action_help(self):
        self.push_screen(HelpScreen())


def run_tui():
    TennisBookerApp().run()


if __name__ == "__main__":
    run_tui()
