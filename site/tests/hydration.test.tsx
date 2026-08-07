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
    maximumSessions: 6,
  },
  initialSchedules: [],
  initialDay: "2026-07-26",
  tokenConfigured: true,
  initialBookingCredential: {
    status: "current" as const,
    issuedAt: "2026-08-07T04:00:00.000Z",
    minimumIssuedAt: "2026-02-28T16:00:00.000Z",
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
  assert.match(markup, /Token update needed/);
  assert.match(markup, /AUTO.*BLOCKED/);
  assert.match(markup, /Update the Dooremi token before the next release/);
  assert.doesNotMatch(markup, /Dooremi live|AUTO.*ARMED/);
});
