import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "react-dom/server";

import { TennisDashboard } from "../app/tennis-dashboard.js";

const props = {
  user: { email: "player@example.test", displayName: "Local player" },
  initialSettings: {
    facilityId: 1466,
    facilityCategoryId: 1216,
    bookingLeadDays: 14,
    releaseHour: 12,
    releaseMinute: 0,
    cancellationLeadSeconds: 15,
    fireDelayMilliseconds: 10,
    maximumSessions: 10,
  },
  initialSchedules: [],
  initialDay: "2026-07-26",
  tokenConfigured: true,
  initialBookingCredential: {
    status: "current" as const,
    issuedAt: "2026-08-07T04:00:00.000Z",
    minimumIssuedAt: "2026-02-28T16:00:00.000Z",
  },
  initialBookingApiGuard: {
    status: "healthy" as const,
    bookingsEnabled: true,
    expectedAppVersion: "1.7.0",
    observedAppVersion: "1.7.0",
    checkedAt: "2026-08-17T00:00:00.000Z",
    lastHealthyAt: "2026-08-17T00:00:00.000Z",
    disabledAt: null,
    failureCode: null,
    failureMessage: null,
    message: "Booking APIs are verified and writes are enabled.",
  },
  automationReady: false,
};

test("initial dashboard markup is stable across a clock tick", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 1_784_000_000_999;
    const serverMarkup = renderToString(<TennisDashboard {...props} />);

    Date.now = () => 1_784_000_001_001;
    const hydrationMarkup = renderToString(<TennisDashboard {...props} />);

    assert.equal(hydrationMarkup, serverMarkup);
    assert.match(serverMarkup, /Syncing release/);
  } finally {
    Date.now = originalNow;
  }
});

test("a legacy credential is never presented as live or armed", () => {
  const markup = renderToString(
    <TennisDashboard
      {...props}
      automationReady
      initialBookingCredential={{
        status: "upgrade_required",
        issuedAt: "2026-01-14T15:50:16.000Z",
        minimumIssuedAt: "2026-02-28T16:00:00.000Z",
      }}
    />,
  );
  assert.match(markup, /BOOKING BLOCKED/);
  assert.match(markup, /Sign-in retry needed/);
  assert.match(markup, /AUTO.*BLOCKED/);
  assert.match(markup, /Automatic Dooremi sign-in needs attention/);
  assert.doesNotMatch(markup, /Dooremi live|AUTO.*ARMED/);
});

test("a failed API guard presents a latched freeze while preserving plan cancellation", () => {
  const markup = renderToString(
    <TennisDashboard
      {...props}
      automationReady
      initialBookingApiGuard={{
        ...props.initialBookingApiGuard,
        status: "disabled",
        bookingsEnabled: false,
        disabledAt: "2026-08-17T01:00:00.000Z",
        failureCode: "app_version_changed",
        failureMessage: "Get a current HAR before re-enabling writes.",
        message: "Get a current HAR before re-enabling writes.",
      }}
    />,
  );
  assert.match(markup, /BOOKING BLOCKED/);
  assert.match(markup, /All booking writes are frozen/);
  assert.match(markup, /Validate and enable booking APIs/);
  assert.match(markup, /Get a current HAR/);
});
