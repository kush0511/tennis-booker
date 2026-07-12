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

The Worker exports a scheduled handler and the application exposes
`POST /api/automation/run-due`, authenticated with `AUTOMATION_SECRET`. The
packaged Worker registers a once-per-minute Cron Trigger. Each invocation writes
a non-secret heartbeat before claiming due plans, and the D1 lease prevents
overlapping invocations from executing the same plan twice. Local ScheduledEvent
dispatch is verified, but the current Sites deployment control plane accepts the
artifact without installing its Cron Trigger. Keep
`AUTOMATION_TRIGGER_ENABLED=false` until the protected
`GET /api/automation/status` endpoint reports a production heartbeat.
