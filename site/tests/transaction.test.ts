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
  LatencyPreflightError,
  PartialBookingError,
  RebookingSubmissionError,
  cancelActiveTennisBookings,
  compensatedSubmissionTiming,
  executeBookingTransaction,
  prepareRebookingBatch,
  type BookingTransactionClient,
} from "../lib/transaction.js";

const noSleep = async () => {};

function confirmedBooking(
  id: number,
  eventTimes: string[] = ["07:00-08:00"],
  eventDay = "Fri, 17/07/2026",
): BookingRecord {
  return {
    id,
    facilityName: "Tennis Court",
    eventDay,
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

test("multiple cancellations share one timeout window instead of running serially", async () => {
  const gates: Array<() => void> = [];
  const started: number[] = [];
  const active = new Set([100, 101, 102, 103]);
  const client: BookingTransactionClient = {
    warmup: async () => ({ elapsedMs: 1, serverDate: null }),
    cancelBooking: (id) => {
      started.push(id);
      return new Promise((resolve) => {
        gates.push(() => {
          active.delete(id);
          resolve({ message: "accepted", bookingId: id });
        });
      });
    },
    bookingHistory: async () =>
      [...active].map((id) => confirmedBooking(id)),
    createSingleBooking: async () => ({ message: "ok", bookingOrderId: 1 }),
  };
  const cancellation = cancelActiveTennisBookings(
    client,
    [...active].map((id) => confirmedBooking(id)),
    { sleep: noSleep },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started, [100, 101, 102, 103]);
  gates.forEach((release) => release());
  assert.deepEqual(await cancellation, [100, 101, 102, 103]);
});

class TransactionFake implements BookingTransactionClient {
  readonly timeline: string[] = [];
  readonly submitted: Schedule[] = [];
  readonly active = new Map<number, BookingRecord>();
  readonly failTimes = new Set<string>();
  readonly ambiguousConfirmedTimes = new Set<string>();
  readonly rejectedAttempts = new Map<string, number>();
  readonly warmupSamples: number[] = [];
  warmupFailuresRemaining = 0;
  nextOrderId = 900;

  async warmup(): Promise<WarmupResult> {
    this.timeline.push("warm");
    if (this.warmupFailuresRemaining > 0) {
      this.warmupFailuresRemaining -= 1;
      throw new DooremiError("probe failed", "connectivity");
    }
    return {
      elapsedMs: this.warmupSamples.shift() ?? 1,
      serverDate: null,
    };
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
    const remainingRejections = this.rejectedAttempts.get(time) ?? 0;
    if (remainingRejections > 0) {
      this.rejectedAttempts.set(time, remainingRejections - 1);
      throw new DooremiError(
        "Dooremi rejected the request (1): Unexpected error",
        "rejected",
      );
    }
    if (this.failTimes.has(time)) {
      if (this.ambiguousConfirmedTimes.has(time)) {
        this.nextOrderId += 1;
        this.active.set(
          this.nextOrderId,
          confirmedBooking(this.nextOrderId, [time], schedule.eventDay),
        );
      }
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

test("the release calibration collects five bounded probes before submission", async () => {
  const client = new TransactionFake();
  client.warmupSamples.push(90, 80, 100, 120, 140, 110, 95);
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
      secondWarmupAt: new Date(0),
      fireAt: new Date(0),
      latencyProbeCount: 5,
      latencyProbeIntervalMilliseconds: 75,
      latencyProbeTimeoutMilliseconds: 500,
      now: () => new Date(0),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    },
  );
  assert.equal(
    client.timeline.filter((item) => item === "warm").length,
    7,
  );
  assert.deepEqual(sleeps, [75, 75, 75, 75]);
  assert.equal(client.submitted.length, 1);
});

test("hosted cancellation waits for the narrow destructive window", async () => {
  const client = new TransactionFake();
  client.active.set(501, confirmedBooking(501));
  const release = new Date("2026-07-03T04:00:00.000Z");
  let current = release.valueOf() - 60_000;
  const sleeps: number[] = [];
  await executeBookingTransaction(
    client,
    {
      eventDay: "2026-07-17",
      eventTimes: ["19:00-20:00"],
      facilityId: 9001,
    },
    {
      activeBookings: [...client.active.values()],
      warmupPasses: 2,
      cancelAt: new Date(release.valueOf() - 15_000),
      secondWarmupAt: new Date(release.valueOf() - 3_000),
      fireAt: release,
      now: () => new Date(current),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        current += milliseconds;
      },
    },
  );
  assert.deepEqual(sleeps, [45_000, 200, 11_800, 3_000]);
  assert.ok(
    client.timeline.indexOf("cancel:501") > client.timeline.indexOf("warm"),
  );
});

test("submission timing compensates measured transit with a bounded lead", () => {
  const release = new Date("2026-07-03T04:00:00.000Z");
  const timing = compensatedSubmissionTiming(
    release,
    10,
    [80, 100, 120],
    {
      maximumTransmissionLeadMilliseconds: 40,
      minimumSampleCount: 5,
      fallbackRoundTripMilliseconds: 120,
    },
  );
  assert.equal(timing.medianRoundTripMilliseconds, 100);
  assert.equal(timing.transmissionLeadMilliseconds, 40);
  assert.equal(timing.fireAt.valueOf(), release.valueOf() - 30);
  assert.equal(timing.usedFallback, true);
});

test("submission timing uses a recent p75 sample set instead of a fixed cap", () => {
  const release = new Date("2026-07-03T04:00:00.000Z");
  const timing = compensatedSubmissionTiming(
    release,
    10,
    [80, 100, 120, 140, 400],
    {
      maximumTransmissionLeadMilliseconds: 250,
      latencyPercentile: 0.75,
      minimumSampleCount: 5,
      fallbackRoundTripMilliseconds: 120,
    },
  );
  assert.equal(timing.sampleCount, 5);
  assert.equal(timing.medianRoundTripMilliseconds, 120);
  assert.equal(timing.calibratedRoundTripMilliseconds, 140);
  assert.equal(timing.transmissionLeadMilliseconds, 70);
  assert.equal(timing.fireAt.valueOf(), release.valueOf() - 60);
  assert.equal(timing.usedFallback, false);
});

test("the transaction fires from its near-release latency calibration", async () => {
  const client = new TransactionFake();
  client.warmupSamples.push(90, 80, 100, 120, 140, 400, 110);
  const release = new Date("2026-07-03T04:00:00.000Z");
  let current = release.valueOf() - 4_000;
  const sleeps: number[] = [];
  await executeBookingTransaction(
    client,
    {
      eventDay: "2026-07-17",
      eventTimes: ["19:00-20:00"],
      facilityId: 9001,
    },
    {
      activeBookings: [],
      warmupPasses: 2,
      secondWarmupAt: new Date(current),
      releaseAt: release,
      fireDelayMilliseconds: 10,
      latencyProbeCount: 5,
      latencyProbeIntervalMilliseconds: 75,
      latencyProbeTimeoutMilliseconds: 500,
      latencyCalibrationCutoffMilliseconds: 1_500,
      latencyPercentile: 0.75,
      minimumLatencySamples: 5,
      fallbackRoundTripMilliseconds: 120,
      maximumTransmissionLeadMilliseconds: 250,
      now: () => new Date(current),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        current += milliseconds;
      },
    },
  );
  assert.equal(current, release.valueOf() - 58);
  assert.deepEqual(sleeps.slice(0, 4), [75, 75, 75, 75]);
  assert.equal(client.submitted.length, 1);
});

test("the pre-cancellation latency gate preserves existing bookings when probes fail", async () => {
  const client = new TransactionFake();
  client.active.set(501, confirmedBooking(501));
  // Two initial target warmups plus all three gate probes fail.
  client.warmupFailuresRemaining = 5;
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
        cancelAt: new Date(0),
        preCancellationProbeCount: 3,
        preCancellationMinimumSuccesses: 2,
        latencyProbeTimeoutMilliseconds: 500,
        sleep: noSleep,
      },
    ),
    LatencyPreflightError,
  );
  assert.equal(client.timeline.some((item) => item.startsWith("cancel:")), false);
  assert.equal(client.submitted.length, 0);
  assert.equal(client.active.has(501), true);
});

test("an explicit rejection follows the complete bounded retry ladder", async () => {
  const client = new TransactionFake();
  client.rejectedAttempts.set("19:00-20:00", 4);
  const sleeps: number[] = [];
  const timing: string[] = [];
  const result = await executeBookingTransaction(
    client,
    {
      eventDay: "2026-07-17",
      eventTimes: ["19:00-20:00"],
      facilityId: 9001,
    },
    {
      activeBookings: [],
      rejectedSubmissionRetryDelaysMilliseconds: [40, 90, 200, 450],
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      releaseAt: new Date(0),
      now: () => new Date(10),
      onTiming: (message) => timing.push(message),
    },
  );
  assert.equal(result.bookingOrderIds.length, 1);
  assert.deepEqual(sleeps, [40, 90, 200, 450]);
  assert.equal(client.submitted.length, 5);
  assert.ok(timing.some((message) => message.includes("at T+10ms")));
  assert.ok(timing.some((message) => message.includes("returned in")));
});

test("the rejection retry ladder stops after five total attempts", async () => {
  const client = new TransactionFake();
  client.rejectedAttempts.set("19:00-20:00", 10);
  const sleeps: number[] = [];
  await assert.rejects(
    executeBookingTransaction(
      client,
      {
        eventDay: "2026-07-17",
        eventTimes: ["19:00-20:00"],
        facilityId: 9001,
      },
      {
        activeBookings: [],
        rejectedSubmissionRetryDelaysMilliseconds: [40, 90, 200, 450],
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    ),
    (error: unknown) =>
      error instanceof DooremiError && error.code === "rejected",
  );
  assert.equal(client.submitted.length, 5);
  assert.deepEqual(sleeps, [40, 90, 200, 450]);
});

test("retries stay isolated and never resubmit a target that already confirmed", async () => {
  const client = new TransactionFake();
  client.rejectedAttempts.set("19:00-20:00", 2);
  const result = await executeBookingTransaction(
    client,
    {
      eventDay: "2026-07-17",
      eventTimes: ["19:00-20:00", "20:00-21:00"],
      facilityId: 9001,
    },
    {
      activeBookings: [],
      rejectedSubmissionRetryDelaysMilliseconds: [40, 90, 200, 450],
      sleep: noSleep,
    },
  );
  assert.equal(result.bookingOrderIds.length, 2);
  assert.equal(
    client.submitted.filter(
      (schedule) => schedule.eventTimes?.[0] === "19:00-20:00",
    ).length,
    3,
  );
  assert.equal(
    client.submitted.filter(
      (schedule) => schedule.eventTimes?.[0] === "20:00-21:00",
    ).length,
    1,
  );
});

test("an ambiguous response is reconciled from history without a duplicate submit", async () => {
  const client = new TransactionFake();
  client.failTimes.add("19:00-20:00");
  client.ambiguousConfirmedTimes.add("19:00-20:00");
  const result = await executeBookingTransaction(
    client,
    {
      eventDay: "2026-07-17",
      eventTimes: ["19:00-20:00"],
      facilityId: 9001,
    },
    {
      activeBookings: [],
      ambiguousReconciliationDelaysMilliseconds: [0, 250, 750],
      sleep: noSleep,
    },
  );
  assert.equal(result.bookingOrderIds.length, 1);
  assert.equal(client.submitted.length, 1);
  assert.match(result.results[0].result.message, /booking history/i);
});

test("an unresolved ambiguous response is polled but never blindly retried", async () => {
  const client = new TransactionFake();
  client.failTimes.add("19:00-20:00");
  await assert.rejects(
    executeBookingTransaction(
      client,
      {
        eventDay: "2026-07-17",
        eventTimes: ["19:00-20:00"],
        facilityId: 9001,
      },
      {
        activeBookings: [],
        ambiguousReconciliationDelaysMilliseconds: [0, 250, 750],
        sleep: noSleep,
      },
    ),
    AmbiguousSubmissionError,
  );
  assert.equal(client.submitted.length, 1);
  assert.equal(
    client.timeline.filter((item) => item === "history").length,
    3,
  );
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
        rejectedSubmissionRetries: 1,
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
  let caught: unknown;
  try {
    await executeBookingTransaction(
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
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof RebookingSubmissionError);
  assert.equal(caught.failures.length, 2);
  assert.deepEqual(
    caught.bookingTargets.map((target) => target.eventTime),
    ["07:00-08:00", "19:00-20:00"],
  );
  assert.equal(
    client.submitted.filter(
      (schedule) => schedule.eventTimes?.[0] === "19:00-20:00",
    ).length,
    1,
  );
});
