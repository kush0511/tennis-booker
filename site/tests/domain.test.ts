import assert from "node:assert/strict";
import test from "node:test";

import availabilityFixture from "./fixtures/availability.json" with {
  type: "json",
};
import sharedContract from "../../shared/booking-contract.json" with {
  type: "json",
};
import {
  DomainError,
  MAX_BOOKING_TARGETS,
  SCHEDULE_STATUSES,
  activeTennisBookings,
  defaultConfig,
  normalizeBookingTargets,
  normalizeEventDay,
  parseAvailabilityPayload,
  releaseAt,
  validateEventTime,
  type BookingRecord,
} from "../lib/domain.js";
import {
  DOOREMI_BASE_URL,
  DOOREMI_ENDPOINTS,
  DOOREMI_IOS_USER_AGENT,
} from "../lib/dooremi.js";

test("TypeScript defaults match the canonical cross-runtime contract", () => {
  assert.equal(DOOREMI_BASE_URL, sharedContract.api.baseUrl);
  assert.equal(DOOREMI_IOS_USER_AGENT, sharedContract.api.userAgent);
  assert.deepEqual(DOOREMI_ENDPOINTS, sharedContract.api.endpoints);
  assert.equal(defaultConfig.bookingLeadDays, sharedContract.defaults.bookingLeadDays);
  assert.equal(defaultConfig.releaseHour, sharedContract.defaults.releaseHour);
  assert.equal(defaultConfig.releaseMinute, sharedContract.defaults.releaseMinute);
  assert.equal(
    defaultConfig.cancellationLeadSeconds,
    sharedContract.defaults.cancellationLeadSeconds,
  );
  assert.equal(
    defaultConfig.fireDelayMilliseconds,
    sharedContract.defaults.fireDelayMilliseconds,
  );
  assert.equal(MAX_BOOKING_TARGETS, sharedContract.defaults.maximumSessions);
  assert.deepEqual(SCHEDULE_STATUSES, sharedContract.statuses);
});

test("releaseAt uses the configured Singapore release boundary", () => {
  assert.equal(
    releaseAt("2026-07-17", {
      bookingLeadDays: 14,
      releaseHour: 12,
      releaseMinute: 0,
    }).toISOString(),
    "2026-07-03T04:00:00.000Z",
  );
});

test("date and session normalization rejects rollover and reverse ranges", () => {
  assert.equal(normalizeEventDay("Fri, 17/07/2026"), "2026-07-17");
  assert.throws(() => normalizeEventDay("2026-02-30"), DomainError);
  assert.throws(() => validateEventTime("18:00-17:00"), DomainError);
  assert.equal(validateEventTime("07:00-08:00"), "07:00-08:00");
});

test("availability parsing preserves the captured Dooremi slot semantics", () => {
  const result = parseAvailabilityPayload(availabilityFixture, 9001);
  assert.equal(result.facilityName, "Tennis Court");
  assert.equal(result.maximumSelectableSlots, 1);
  assert.deepEqual(
    result.slots.map((slot) => [slot.eventTime, slot.available]),
    [
      ["07:00-08:00", true],
      ["08:00-09:00", false],
    ],
  );
});

test("booking targets normalize cross-date values and deduplicate exactly", () => {
  assert.deepEqual(
    normalizeBookingTargets({
      eventDay: "2026-07-18",
      eventTimes: ["19:00-20:00"],
      facilityId: 9001,
      bookingTargets: [
        {
          eventDay: "Fri, 17/07/2026",
          eventTime: "07:00-08:00",
          facilityId: 9001,
        },
        {
          eventDay: "2026-07-17",
          eventTime: "07:00-08:00",
          facilityId: 9001,
        },
        {
          eventDay: "2026-07-18",
          eventTime: "19:00-20:00",
          facilityId: 9001,
        },
      ],
    }),
    [
      {
        eventDay: "2026-07-17",
        eventTime: "07:00-08:00",
        facilityId: 9001,
      },
      {
        eventDay: "2026-07-18",
        eventTime: "19:00-20:00",
        facilityId: 9001,
      },
    ],
  );
});

test("only confirmed tennis orders are considered active rebooking inputs", () => {
  const base: BookingRecord = {
    id: 1,
    facilityName: "Tennis Court",
    eventDay: "Fri, 17/07/2026",
    eventTime: "07:00-08:00",
    eventTimes: ["07:00-08:00"],
    status: 1,
    statusName: "Confirmed",
    canCancel: true,
    categoryType: 7,
  };
  assert.deepEqual(
    activeTennisBookings([
      base,
      { ...base, id: 2, facilityName: "Function Room" },
      { ...base, id: 3, statusName: "Cancelled" },
    ]).map((booking) => booking.id),
    [1],
  );
});
