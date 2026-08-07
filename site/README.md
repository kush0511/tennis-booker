# Court Signal

Court Signal is the mobile-first ChatGPT Sites implementation of Tennis Booker.
It checks live Dooremi availability, stores release plans in D1, executes the
same safe cancel-and-rebook transaction as the local app, and keeps credentials
server-only.

## Runtime configuration

Configure these through the Site settings in ChatGPT before redeploying:

- `DOOREMI_BEARER_TOKEN` — secret; the raw token without a `Bearer` prefix.
- `AUTOMATION_SECRET` — secret used only by the signed runner endpoint.
- `DOOREMI_FACILITY_ID` — optional initial facility ID.
- `DOOREMI_CATEGORY_ID` — optional initial category ID.

`LOCAL_DEV_USER_EMAIL` is for local development only. It must not be configured
for the production deployment.

The application never writes the Dooremi token to D1, browser state, HTML,
serialized errors, or logs.

## Commands

```bash
npm ci
npm run dev
npm test
npm run lint
npm run db:generate
```

`npm test` compiles the deployment, runs TypeScript domain/transport/transaction
tests, and verifies the server-rendered protected entry page.

## Persistence and automation

D1 stores per-user settings, schedules, active-slot claims, results, and
sanitized events. A composite slot key prevents overlapping active schedules,
and a lease-based claim prevents two runner invocations from executing the same
plan.

Hosted execution claims and warms each transaction at least 60 seconds before
release, but does not expose existing bookings for that full preparation
window. At the configured T-15-second boundary it runs three authenticated,
read-only latency probes and requires at least two successes before cancelling
anything. After cancellation and history verification, it takes ten more
bounded samples near release and derives the transmit lead from the current p75
RTT, with a 120ms fallback floor and a 250ms maximum. Because RTT/2 can
overstate outbound transit, an early-send guard keeps the first request no
earlier than T-5ms. The ten-sample release probe train also records provider
Date-header lag and regressions. Explicit JSON rejections follow a bounded
0/0/25/100/400/1000ms delay ladder, closing the old post-rejection gap while
covering lagging provider instances. Ambiguous submissions are never blindly
resent; the runner polls booking history at absolute offsets
0/250/750/1500ms. Before declaring any final rejection, it reconciles booking
history and records whether each target is still available or has become
booked. Due plans execute in parallel so one user's release wait cannot delay
another user's plan.

The Worker exports a scheduled handler and the application exposes
`POST /api/automation/run-due`, authenticated with `AUTOMATION_SECRET`. The
packaged Worker registers a once-per-minute Cron Trigger. Each invocation writes
a non-secret heartbeat before claiming due plans, and the D1 lease prevents
overlapping invocations from executing the same plan twice. Local ScheduledEvent
dispatch is verified, but the current Sites deployment control plane accepts the
artifact without installing its Cron Trigger. The protected
`GET /api/automation/status` endpoint remains available for deployment checks.
Set `AUTOMATION_TRIGGER_ENABLED=true` only while a verified external runner is
connected.

The production Site uses one enabled Google Cloud Scheduler HTTP job in
`asia-southeast1`, evaluated in `Asia/Singapore`: `* * * * *`. It calls the
signed runner every minute, all day, with a ten-minute attempt deadline. The
Sites bypass and automation credentials are sent only as protected request
headers; the Dooremi token never leaves Sites. Court Signal can therefore run
armed plans for any configured release time without a Mac staying awake.
