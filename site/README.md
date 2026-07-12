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

Hosted execution begins at least 90 seconds before release, sends distinct
booking cancellations with a small concurrent stagger, verifies history, then
re-warms all replacement connections at T-3 seconds. Due plans execute in
parallel so one user's release wait cannot delay another user's plan. The
15-second local value is not treated as a sufficient hosted timeout budget.

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

The production Site uses two Google Cloud Scheduler HTTP jobs in
`asia-southeast1`, evaluated in `Asia/Singapore`: `30-59 11 * * *` and
`0-5 12 * * *`. They call the signed runner every minute from 11:30 through
12:05 with a ten-minute attempt deadline. The Sites bypass and automation
credentials are sent only as protected request headers; the Dooremi token never
leaves Sites. Court Signal only reports unattended automation as ready when the
configured release time falls inside that wake window; releases outside it use
the manual four-minute arming flow until external coverage is expanded.
