import assert from "node:assert/strict";
import test from "node:test";

import rebookingFixture from "./fixtures/rebooking-contract.json" with {
  type: "json",
};
import type { BookingRecord, Schedule } from "../lib/domain.js";
import {
  AmbiguousSubmissionError,
  DooremiError,
  type CancelBookingResult,
  type SingleBookingResult,
  type WarmupResult,
} from "../lib/dooremi.js";
import {
  PartialBookingError,
  RebookingSubmissionError,
  cancelActiveTennisBookings,
  executeBookingTransaction,
  prepareRebookingBatch,
  type BookingTransactionClient,
} from "../lib/transaction.js";

const noSleep = async () => {};

function confirmedBooking(
  id: number,
  eventTimes: string[] = ["07:00-08:00"],
): BookingRecord {
  return {
    id,
    facilityName: "Tennis Court",
    eventDay: "Fri, 17/07/2026",
    eventTime: eventTimes.join(" · "),
    eventTimes,
    status: 1,
    statusName: "Confirmed",
    canCancel: true,
    categoryType: 7,
  };
}

test("the shared rebooking fixture merges and normalizes all preserved targets", () => {
  const prepared = prepareRebookingBatch(
    rebookingFixture.schedule,
    rebookingFixture.activeBookings,
  );
  assert.deepEqual(prepared.bookingTargets, rebookingFixture.expectedTargets);
});

test("the six-session limit is checked before cancellation", async () => {
  let cancelCalls = 0;
  const client: BookingTransactionClient = {
    warmup: async () => ({ elapsedMs: 1, serverDate: null }),
    bookingHistory: async () => [],
    cancelBooking: async () => {
      cancelCalls += 1;
      return { message: "cancelled", bookingId: 1 };
    },
    createSingleBooking: async () => ({
      message: "ok",
      bookingOrderId: 1,
    }),
  };
  await assert.rejects(
    executeBookingTransaction(
      client,
      {
        eventDay: "2026-07-18",
        eventTimes: ["19:00-20:00", "20:00-21:00"],
        facilityId: 9001,
      },
      {
        activeBookings: [
          confirmedBooking(1, [
            "07:00-08:00",
            "08:00-09:00",
            "09:00-10:00",
            "10:00-11:00",
            "11:00-12:00",
          ]),
        ],
        sleep: noSleep,
      },
    ),
    /Nothing was cancelled/,
  );
  assert.equal(cancelCalls, 0);
});

test("an accepted cancellation is polled without being submitted again", async () => {
  const booking = confirmedBooking(100);
  const cancelCalls: number[] = [];
  let historyCalls = 0;
  const client: BookingTransactionClient = {
    warmup: async () => ({ elapsedMs: 1, serverDate: null }),
    cancelBooking: async (id) => {
      cancelCalls.push(id);
      return { message: "accepted", bookingId: id };
    },
    bookingHistory: async () => {
      historyCalls += 1;
      return historyCalls === 1 ? [booking] : [];
    },
    createSingleBooking: async () => ({
      message: "ok",
      bookingOrderId: 1,
    }),
  };
  assert.deepEqual(
    await cancelActiveTennisBookings(client, [booking], { sleep: noSleep }),
    [100],
  );
  assert.deepEqual(cancelCalls, [100]);
  assert.equal(historyCalls, 2);
});

test("only a cancellation that was not accepted is retried", async () => {
  const active = new Set([100, 101]);
  const cancelCalls: number[] = [];
  const client: BookingTransactionClient = {
    warmup: async () => ({ elapsedMs: 1, serverDate: null }),
    cancelBooking: async (id) => {
      cancelCalls.push(id);
      if (id === 101 && cancelCalls.filter((value) => value === 101).length === 1) {
        throw new DooremiError("temporary error");
      }
      active.delete(id);
      return { message: "accepted", bookingId: id };
    },
    bookingHistory: async () =>
      [...active].map((id) => confirmedBooking(id)),
    createSingleBooking: async () => ({
      message: "ok",
      bookingOrderId: 1,
    }),
  };
  assert.deepEqual(
    await cancelActiveTennisBookings(
      client,
      [confirmedBooking(100), confirmedBooking(101)],
      { sleep: noSleep },
    ),
    [100, 101],
  );
  assert.deepEqual(cancelCalls, [100, 101, 101]);
});

class TransactionFake implements BookingTransactionClient {
  readonly timeline: string[] = [];
  readonly submitted: Schedule[] = [];
  readonly active = new Map<number, BookingRecord>();
  readonly failTimes = new Set<string>();
  nextOrderId = 900;

  async warmup(): Promise<WarmupResult> {
    this.timeline.push("warm");
    return { elapsedMs: 1, serverDate: null };
  }

  async bookingHistory(): Promise<BookingRecord[]> {
    this.timeline.push("history");
    return [...this.active.values()];
  }

  async cancelBooking(bookingId: number): Promise<CancelBookingResult> {
    this.timeline.push(`cancel:${bookingId}`);
    this.active.delete(bookingId);
    return { message: "accepted", bookingId };
  }

  async createSingleBooking(schedule: Schedule): Promise<SingleBookingResult> {
    const time = schedule.eventTimes?.[0] ?? "";
    this.timeline.push(`create:${time}`);
    this.submitted.push(schedule);
    if (this.failTimes.has(time)) {
      throw new AmbiguousSubmissionError();
    }
    this.nextOrderId += 1;
    return { message: "ok", bookingOrderId: this.nextOrderId };
  }

  fork(): BookingTransactionClient {
    return this;
  }
}

test("execution warms, verifies cancellation, then submits every target once", async () => {
  const client = new TransactionFake();
  client.active.set(
    501,
    confirmedBooking(501, ["07:00-08:00", "08:00-09:00"]),
  );
  let tick = 0;
  const result = await executeBookingTransaction(
    client,
    {
      eventDay: "2026-07-18",
      eventTimes: ["19:00-20:00", "20:00-21:00"],
      facilityId: 9001,
    },
    {
      activeBookings: [...client.active.values()],
      sleep: noSleep,
      monotonicNow: () => (tick += 0.1),
      warmupPasses: 2,
    },
  );
  assert.deepEqual(result.cancelledBookingIds, [501]);
  assert.equal(result.bookingTargets.length, 4);
  assert.equal(client.submitted.length, 4);
  assert.deepEqual(
    client.submitted.map((schedule) => schedule.eventTimes),
    [
      ["07:00-08:00"],
      ["08:00-09:00"],
      ["19:00-20:00"],
      ["20:00-21:00"],
    ],
  );
  const cancelIndex = client.timeline.indexOf("cancel:501");
  const firstCreateIndex = client.timeline.findIndex((item) =>
    item.startsWith("create:"),
  );
  assert.ok(cancelIndex >= 4);
  assert.ok(firstCreateIndex > cancelIndex);
  assert.equal(result.bookingOrderIds.length, 4);
});

test("scheduled timing waits for T-3 before the second warmup and then for fireAt", async () => {
  const client = new TransactionFake();
  const release = new Date("2026-07-03T04:00:00.000Z");
  let current = release.valueOf() - 15_000;
  const sleeps: number[] = [];
  await executeBookingTransaction(
    client,
    {
      eventDay: "2026-07-17",
      eventTimes: ["07:00-08:00"],
      facilityId: 9001,
    },
    {
      activeBookings: [],
      warmupPasses: 2,
      secondWarmupAt: new Date(release.valueOf() - 3_000),
      fireAt: new Date(release.valueOf() + 10),
      now: () => new Date(current),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        current += milliseconds;
      },
    },
  );
  assert.deepEqual(sleeps, [12_000, 3_010]);
  assert.deepEqual(client.timeline, [
    "warm",
    "warm",
    "create:07:00-08:00",
  ]);
});

test("a partial result records successes and never retries an ambiguous target", async () => {
  const client = new TransactionFake();
  client.failTimes.add("08:00-09:00");
  let caught: unknown;
  try {
    await executeBookingTransaction(
      client,
      {
        eventDay: "2026-07-17",
        eventTimes: ["07:00-08:00", "08:00-09:00"],
        facilityId: 9001,
      },
      {
        activeBookings: [],
        sleep: noSleep,
        warmupPasses: 1,
      },
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PartialBookingError);
  assert.equal(caught.bookingOrderIds.length, 1);
  assert.deepEqual(
    client.submitted.map((schedule) => schedule.eventTimes?.[0]),
    ["07:00-08:00", "08:00-09:00"],
  );
});

test("complete submission failure after cancellation raises the recovery warning", async () => {
  const client = new TransactionFake();
  client.active.set(501, confirmedBooking(501));
  client.failTimes.add("07:00-08:00");
  client.failTimes.add("19:00-20:00");
  await assert.rejects(
    executeBookingTransaction(
      client,
      {
        eventDay: "2026-07-18",
        eventTimes: ["19:00-20:00"],
        facilityId: 9001,
      },
      {
        activeBookings: [...client.active.values()],
        sleep: noSleep,
        warmupPasses: 1,
      },
    ),
    RebookingSubmissionError,
  );
  assert.equal(
    client.submitted.filter(
      (schedule) => schedule.eventTimes?.[0] === "19:00-20:00",
    ).length,
    1,
  );
});
