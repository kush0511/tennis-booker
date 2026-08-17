# Tennis Booker

A local-first macOS terminal application for checking Dooremi tennis-court
availability and scheduling up to ten sessions at the facility release time.
The default interface is a responsive full-screen TUI built for keyboard and
mouse use. The repository also contains **Court Signal**, a parallel,
mobile-first ChatGPT Sites implementation.

## Architecture

The two runtimes deliberately share behavior without forcing the Sites worker
to emulate macOS or the TUI to depend on a browser:

- `tennis_core/` contains the reusable Python domain, validation, configuration,
  payload, and rebooking rules used by the classic CLI and Textual TUI.
- `shared/booking-contract.json` is the non-secret cross-runtime contract for
  API paths, timing defaults, limits, and schedule statuses.
- `site/lib/` is the Cloudflare-compatible TypeScript implementation of the
  same booking and safety rules, protected by parity fixtures and tests.
- `tennis_booker.py` retains the macOS adapters: Keychain, local JSON storage,
  `launchd`, `pmset`, `caffeinate`, and the local executor.
- `site/` contains the Sites UI, D1 persistence, Sign in with ChatGPT identity,
  hosted-secret access, atomic schedule claims, and the signed runner endpoint.

This keeps the TUI independently usable while allowing the hosted application
to evolve in parallel.

## Safety model

- The Dooremi Bearer token is stored in macOS Keychain.
- Tokens are preserved byte-for-byte and requests use the current Dooremi iOS
  transport signature captured from app version 14.
- The token is never written to the repository, configuration, schedules, or
  logs.
- A multi-session attempt follows Dooremi’s documented temporary workaround:
  one single-slot POST per session, released together over up to ten HTTPS
  connections.
- The executor pre-warms one connection per selected session, then submits just
  after the opening boundary. It never retries an ambiguous request.
- Before any immediate or scheduled transaction, active tennis bookings are
  cancelled, verified, and added to the synchronized replacement batch.
  Non-tennis bookings are never touched.
- If the combined active and selected sessions exceed ten, the operation stops
  before cancelling anything.
- The hosted app maintains a durable booking API guard. A changed Dooremi app
  version, failed read-only contract probe, or stale health check freezes every
  booking and provider-cancellation write before an existing reservation can
  be changed. Only an owner validation can clear the latched safety lock.
- Booking dates, times, results, and sanitized errors are stored under
  `~/Library/Application Support/TennisBooker`.
- Runner logs live under `~/Library/Logs/TennisBooker`.

## Install

```bash
cd /path/to/tennis-booker
./install.sh
```

If `~/.local/bin` is not already on your `PATH`, add:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then start the conversational interface:

```bash
tennis-booker
```

The interface adapts from a two-pane booking dashboard to a stacked compact
layout as the terminal narrows. Useful keys:

```text
← / →   Change booking date
Tab      Move through session tiles
Space   Select a session
Enter   Open or confirm
R       Refresh live state
Ctrl+O  My Dooremi bookings
Ctrl+J  Local automation
Ctrl+P  Command palette
?       Keyboard map
Q       Quit
```

For scripts or terminals that do not support a full-screen application, the
original conversational interface remains available:

```bash
tennis-booker --classic
```

On first run, open **System → Connect** and provide the path to a local HAR
capture from the current Dooremi app. The HAR is only read to import the Bearer
token into Keychain. LifeUp-era tokens can still read availability but are
rejected for booking writes and are blocked before cancellation.
Facility identifiers are deliberately not included in this repository. Set
the values for your property before loading availability:

```bash
tennis-booker config set facility YOUR_FACILITY_ID
tennis-booker config set category YOUR_CATEGORY_ID
```

## Typical flow

```text
❯ /availability
Session date [2026-07-17]:

Tennis Court · 2026-07-17
   1  16:00-17:00  available
   –  17:00-18:00  booked

Select slot numbers (up to 10): 1, 2
```

If the booking window has not opened, the app schedules the request and adds a
macOS hardware wake event. If the window is already open, it asks for
confirmation before starting the verified cancel-and-rebook transaction.
**My bookings** shows confirmed and previous orders and enables cancellation
only when Dooremi returns `canCancel`.

Authentication failures and network failures are separate states. HTTP 401/403
or an explicit token/login rejection marks the session invalid; DNS,
connectivity, and timeout failures leave the Keychain token untouched.

To inspect the stored JWT's structure and claim values without printing the
raw credential or signature:

```bash
python3 inspect_token.py
```

## How scheduling works

For a future session the application:

1. Saves one local schedule containing the selected session(s).
2. Installs a `pmset` hardware wake three minutes before release.
3. Lets the `launchd` agent find and arm the job.
4. Uses `caffeinate` to hold the Mac awake.
5. Fifteen seconds before release, discovers active tennis bookings and primes
   one connection per preserved or newly selected session.
6. Cancels and verifies active tennis bookings, polling accepted cancellations
   without resending them while Dooremi's history converges.
7. Releases up to ten independent single-slot requests together at the
   configured post-boundary delay.

The Mac must be sleeping rather than shut down, the user must remain logged in,
and macOS must report real AC power—not merely a cable in a USB-C port.

## Closed-lid verification

Keep the Mac logged in, asleep rather than shut down, connected to power, and
on a usable Wi-Fi network. Run this harmless test before depending on it:

```text
❯ /wake-test 2
```

Close the lid, wait three minutes, then check:

```text
❯ /wake-test status
```

Closed-lid background execution varies by Mac power state and attached
peripherals. If the test fails, leave the lid open with the display asleep or
use supported closed-display mode with external power and display.

## Development

The booking engine is dependency-free Python 3.9+. The interactive interface
uses Textual, installed into an isolated application virtual environment:

```bash
/usr/bin/python3 -m unittest discover -s tests -v
/usr/bin/python3 tennis_booker.py doctor
```

The Sites implementation is developed and verified separately:

```bash
cd site
npm ci
npm test
npm run lint
```

For local Sites development, copy `.env.example` to `.env.local`, configure
non-production values, and run `npm run dev`. Production credentials must be
added as hosted Sites secrets; never commit them or store them in D1.

### Hosted scheduling boundary

Court Signal includes the complete server-side runner and a signed
`POST /api/automation/run-due` boundary. Its packaged Worker registers a
once-per-minute Cron Trigger, writes a non-secret D1 heartbeat, and claims due
plans with a lease so overlapping invocations cannot execute the same release
twice. Local ScheduledEvent dispatch is verified, but the current ChatGPT Sites
deployment accepts the artifact without installing the Cron Trigger: no
production heartbeat appeared across multiple trigger boundaries. Hosted plans
are now woken externally by Google Cloud Scheduler every minute. The signed
runner still performs the exact release timing and D1 lease claiming; the macOS
runner remains an independent fallback. The hosted runner prepares at T-60 but
waits until the configured T-15 boundary to run three read-only latency probes.
At least two must succeed before any existing booking is cancelled. It then
samples latency ten more times near release, derives the transmit lead from the
current p75 RTT, records provider Date-header clock evidence, and caps the first
transmit at T-5ms. Confirmed Dooremi rejections use a bounded
0/0/25/100/400/1000ms retry ladder. Ambiguous submissions are never blindly
resent; booking history is polled at four absolute offsets to reconcile a
confirmation safely. A final explicit rejection is checked against both
booking history and live availability before the run is classified. All due
users arm concurrently. The website does not label a release outside the
external wake window as armed.

The earlier Swift prototype is retained under `Sources/`; the installed
Command Line Tools currently contain a compiler/SDK mismatch, so the installer
uses the Python implementation.
