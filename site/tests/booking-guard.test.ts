import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOKING_API_GUARD_MAX_AGE_MILLISECONDS,
  bookingGuardDecision,
  canAutomationRecoverBookingGuard,
  isCompatiblePreviewBusinessRejection,
  parseDooremiAppVersion,
  parseDooremiAppVersionFromPage,
} from "../lib/booking-guard.js";
import type { BookingApiGuardState } from "../lib/booking-guard.js";

const healthyGuard: BookingApiGuardState = {
  status: "healthy",
  bookingsEnabled: true,
  expectedAppVersion: "1.7.0",
  observedAppVersion: "1.7.0",
  checkedAt: "2026-08-17T00:00:00.000Z",
  lastHealthyAt: "2026-08-17T00:00:00.000Z",
  disabledAt: null,
  failureCode: null,
  failureMessage: null,
  updatedAt: "2026-08-17T00:00:00.000Z",
};

test("booking writes fail closed until a compatibility check exists", () => {
  assert.equal(bookingGuardDecision(null).reason, "missing");
  assert.equal(bookingGuardDecision(null).enabled, false);
});

test("a fresh verified contract enables writes", () => {
  const decision = bookingGuardDecision(
    healthyGuard,
    Date.parse(healthyGuard.checkedAt!) + 1_000,
  );
  assert.equal(decision.reason, "healthy");
  assert.equal(decision.enabled, true);
});

test("a stale or latched guard blocks creates and cancellations", () => {
  assert.equal(
    bookingGuardDecision(
      healthyGuard,
      Date.parse(healthyGuard.checkedAt!) +
        BOOKING_API_GUARD_MAX_AGE_MILLISECONDS +
        1,
    ).reason,
    "stale",
  );
  assert.equal(
    bookingGuardDecision({
      ...healthyGuard,
      status: "disabled",
      bookingsEnabled: false,
      failureCode: "app_version_changed",
      failureMessage: "Get a current HAR.",
    }).message,
    "Get a current HAR.",
  );
});

test("the App Store parser selects only the Dooremi app record", () => {
  assert.equal(
    parseDooremiAppVersion({
      results: [
        { trackId: 1, version: "99.0" },
        { trackId: 6484507473, version: "1.7.0" },
      ],
    }),
    "1.7.0",
  );
  assert.throws(() => parseDooremiAppVersion({ results: [] }));
  assert.equal(
    parseDooremiAppVersionFromPage("<p>Version 1.7.0</p>"),
    "1.7.0",
  );
});

test("the known provider booking-limit rejection proves preview compatibility", () => {
  const rejection = {
    code: "rejected",
    message:
      "Dooremi rejected the request (1): You have reached the booking limit according to House Rules",
  };
  assert.equal(isCompatiblePreviewBusinessRejection(rejection), true);
  assert.equal(canAutomationRecoverBookingGuard({
    failureCode: rejection.code,
    failureMessage: rejection.message,
  }), true);
  assert.equal(
    isCompatiblePreviewBusinessRejection({
      code: "rejected",
      message: "The booking endpoint returned an unfamiliar rule.",
    }),
    false,
  );
});
