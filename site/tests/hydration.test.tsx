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
  tokenConfigured: true,
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
