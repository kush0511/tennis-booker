import assert from "node:assert/strict";
import test from "node:test";
import {
  bookingHistorySections,
  bookingPresentationSections,
  rankedSlotGroups,
  timeSlotGroups,
  type AvailabilityWindowDay,
} from "../lib/slot-discovery.js";

function day(
  eventDay: string,
  slots: Array<[eventTime: string, available: boolean]>,
): AvailabilityWindowDay {
  return {
    eventDay,
    facilityId: 1466,
    facilityName: "Tennis Court",
    error: null,
    slots: slots.map(([eventTime, available], index) => ({
      id: index + 1,
      facilityId: 1466,
      eventTime,
      available,
    })),
  };
}

test("best-slot ranking favors connected evening play", () => {
  const groups = rankedSlotGroups([
    day("2026-08-20", [
      ["07:00-08:00", true],
      ["08:00-09:00", true],
      ["09:00-10:00", true],
    ]),
    day("2026-08-21", [
      ["18:00-19:00", true],
      ["19:00-20:00", true],
      ["20:00-21:00", false],
    ]),
  ]);

  assert.equal(groups[0].eventDay, "2026-08-21");
  assert.deepEqual(groups[0].eventTimes, ["18:00-19:00", "19:00-20:00"]);
  assert.equal(groups[0].eveningSlotCount, 2);
  assert.ok(groups[0].score > groups[1].score);
});

test("monitor filters apply both time range and contiguous requirement", () => {
  const groups = rankedSlotGroups(
    [
      day("2026-08-20", [
        ["17:00-18:00", true],
        ["18:00-19:00", true],
        ["19:00-20:00", true],
        ["21:00-22:00", true],
      ]),
    ],
    { startMinute: 18 * 60, endMinute: 22 * 60, minimumContiguousSlots: 2 },
  );

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].eventTimes, ["18:00-19:00", "19:00-20:00"]);
});

test("timeslot browser groups occurrences by clock time and marks connected runs", () => {
  const groups = timeSlotGroups([
    day("2026-08-20", [
      ["07:00-08:00", true],
      ["08:00-09:00", true],
    ]),
    day("2026-08-21", [
      ["07:00-08:00", true],
      ["08:00-09:00", false],
    ]),
  ]);

  assert.equal(groups[0].eventTime, "07:00-08:00");
  assert.deepEqual(
    groups[0].occurrences.map((occurrence) => [
      occurrence.eventDay,
      occurrence.runLength,
    ]),
    [
      ["2026-08-20", 2],
      ["2026-08-21", 1],
    ],
  );
});

test("booking history is chronological for upcoming sessions and newest-first for previous", () => {
  const bookings = [
    {
      id: 3,
      eventDay: "Fri, 21/08/2026",
      eventTime: "19:00-20:00",
      eventTimes: ["19:00-20:00"],
    },
    {
      id: 1,
      eventDay: "2026-08-19",
      eventTime: "08:00-09:00",
      eventTimes: ["08:00-09:00"],
    },
    {
      id: 2,
      eventDay: "Thu, 20/08/2026",
      eventTime: "07:00-08:00",
      eventTimes: ["07:00-08:00"],
    },
  ];

  const sections = bookingHistorySections(bookings, "2026-08-20");
  assert.deepEqual(sections.upcoming.map((booking) => booking.id), [2, 3]);
  assert.deepEqual(sections.previous.map((booking) => booking.id), [1]);
});

test("cancelled records are removed from the default booking itinerary", () => {
  const bookings = [
    {
      id: 1,
      eventDay: "2026-08-23",
      eventTime: "18:00-19:00",
      eventTimes: ["18:00-19:00"],
      statusName: "Confirmed",
    },
    {
      id: 2,
      eventDay: "2026-08-24",
      eventTime: "19:00-20:00",
      eventTimes: ["19:00-20:00"],
      statusName: "Cancelled",
    },
    {
      id: 3,
      eventDay: "2026-08-21",
      eventTime: "07:00-08:00",
      eventTimes: ["07:00-08:00"],
      statusName: "Canceled by provider",
    },
  ];

  const sections = bookingPresentationSections(bookings, "2026-08-22");
  assert.deepEqual(sections.upcoming.map((booking) => booking.id), [1]);
  assert.deepEqual(sections.previous.map((booking) => booking.id), []);
  assert.deepEqual(sections.cancelled.map((booking) => booking.id), [2, 3]);
});
