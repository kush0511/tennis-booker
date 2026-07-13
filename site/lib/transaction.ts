import {
  MAX_BOOKING_TARGETS,
  DomainError,
  activeTennisBookings,
  normalizeBookingTargets,
  normalizeEventDay,
  singleTargetSchedule,
  type BookingRecord,
  type BookingTarget,
  type Schedule,
} from "./domain.js";
import {
  DooremiError,
  safeErrorMessage,
  type CancelBookingResult,
  type SingleBookingResult,
  type WarmupResult,
} from "./dooremi.js";

export class CancellationError extends Error {
  readonly pendingBookingIds: number[];

  constructor(pendingBookingIds: readonly number[], attempts: number) {
    const noun = pendingBookingIds.length === 1 ? "booking" : "bookings";
    super(
      `Dooremi still shows ${noun} ${pendingBookingIds.join(", ")} as confirmed after ${attempts} attempts. No rebooking requests were sent.`,
    );
    this.name = "CancellationError";
    this.pendingBookingIds = [...pendingBookingIds];
  }
}

export interface ConfirmedSubmission {
  target: BookingTarget;
  result: SingleBookingResult;
  startedMs: number;
}

export interface FailedSubmission {
  target: BookingTarget;
  error: Error;
  startedMs: number;
}

export class PartialBookingError extends Error {
  readonly results: ConfirmedSubmission[];
  readonly failures: FailedSubmission[];
  readonly submitSkewMs: number;
  readonly cancelledBookingIds: number[];

  constructor(
    results: readonly ConfirmedSubmission[],
    failures: readonly FailedSubmission[],
    submitSkewMs: number,
    cancelledBookingIds: readonly number[],
  ) {
    super(
      `${results.length} of ${results.length + failures.length} requests returned a success. Refresh booking history before retrying; one or more requests failed or had an ambiguous response.`,
    );
    this.name = "PartialBookingError";
    this.results = [...results];
    this.failures = [...failures];
    this.submitSkewMs = submitSkewMs;
    this.cancelledBookingIds = [...cancelledBookingIds];
  }

  get bookingOrderIds(): number[] {
    return this.results
      .map((item) => item.result.bookingOrderId)
      .filter((id): id is number => id !== null);
  }
}

export class RebookingSubmissionError extends Error {
  readonly cancelledBookingIds: number[];

  constructor(cancelledBookingIds: readonly number[], cause: unknown) {
    super(
      `Active bookings were cancelled, but no replacement request was confirmed: ${safeErrorMessage(cause)} Refresh booking history now.`,
    );
    this.name = "RebookingSubmissionError";
    this.cancelledBookingIds = [...cancelledBookingIds];
  }
}

export interface BookingTransactionClient {
  warmup(): Promise<WarmupResult>;
  bookingHistory(options?: {
    pageSize?: number;
    cursor?: string | number;
  }): Promise<BookingRecord[]>;
  cancelBooking(bookingId: number): Promise<CancelBookingResult>;
  createSingleBooking(schedule: Schedule): Promise<SingleBookingResult>;
  fork?(): BookingTransactionClient;
}

export interface PreparedRebookingBatch {
  schedule: Schedule;
  activeBookings: BookingRecord[];
  bookingTargets: BookingTarget[];
}

export function prepareRebookingBatch(
  schedule: Schedule,
  activeBookings: readonly BookingRecord[],
  maxSessions = MAX_BOOKING_TARGETS,
): PreparedRebookingBatch {
  if (
    !Number.isSafeInteger(maxSessions) ||
    maxSessions < 1 ||
    maxSessions > MAX_BOOKING_TARGETS
  ) {
    throw new DomainError(
      `The safe transaction maximum must be between 1 and ${MAX_BOOKING_TARGETS}.`,
    );
  }

  const targets: BookingTarget[] = [];
  for (const booking of activeBookings) {
    for (const eventTime of booking.eventTimes) {
      targets.push({
        eventDay: normalizeEventDay(booking.eventDay),
        eventTime,
        // History does not expose a stable facility ID. The selected tennis
        // facility is the same conservative fallback used by the local runner.
        facilityId: schedule.facilityId,
      });
    }
  }
  targets.push(...normalizeBookingTargets(schedule));

  const preparedSchedule: Schedule = {
    ...schedule,
    bookingTargets: targets,
  };
  const deduplicated = normalizeBookingTargets(preparedSchedule);
  if (deduplicated.length > maxSessions) {
    throw new DomainError(
      `${deduplicated.length} active and selected sessions would be rebooked. The safe maximum is ${maxSessions}. Nothing was cancelled.`,
    );
  }
  return {
    schedule: { ...preparedSchedule, bookingTargets: deduplicated },
    activeBookings: [...activeBookings],
    bookingTargets: deduplicated,
  };
}

export type Sleep = (milliseconds: number) => Promise<void>;

export interface CancellationOptions {
  attempts?: number;
  sleep?: Sleep;
  monotonicNow?: () => number;
  onTiming?: (message: string) => void;
}

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));

const defaultMonotonicNow = () => globalThis.performance.now();

export async function cancelActiveTennisBookings(
  client: BookingTransactionClient,
  bookings: readonly BookingRecord[],
  options: CancellationOptions = {},
): Promise<number[]> {
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new DomainError("Cancellation attempts must be a positive integer.");
  }
  const sleep = options.sleep ?? defaultSleep;
  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  const bookingIds = [
    ...new Set(
      bookings
        .map((booking) => booking.id)
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    ),
  ];
  if (bookingIds.length === 0) return [];

  const pending = new Set(bookingIds);
  const accepted = new Set<number>();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptIds = [...pending].filter((bookingId) => !accepted.has(bookingId));
    const outcomes = await Promise.allSettled(
      attemptIds.map(async (bookingId, index) => {
        // A small stagger avoids a single burst while keeping the total bounded
        // by one upstream timeout rather than N sequential timeouts.
        if (index > 0) await sleep(index * 75);
        const started = monotonicNow();
        await client.cancelBooking(bookingId);
        return { bookingId, elapsedMs: Math.round(monotonicNow() - started) };
      }),
    );
    outcomes.forEach((outcome, index) => {
      const bookingId = attemptIds[index];
      if (outcome.status === "fulfilled") {
        accepted.add(bookingId);
        options.onTiming?.(
          `cancel booking ${bookingId} accepted in ${outcome.value.elapsedMs}ms`,
        );
        return;
      }
      if (!(outcome.reason instanceof DooremiError)) throw outcome.reason;
      options.onTiming?.(
        `cancel booking ${bookingId} attempt ${attempt} failed: ${safeErrorMessage(outcome.reason)}`,
      );
    });

    await sleep(200 * attempt);
    const verificationStarted = monotonicNow();
    const confirmedIds = new Set(
      activeTennisBookings(await client.bookingHistory({ pageSize: 50 })).map(
        (booking) => booking.id,
      ),
    );
    options.onTiming?.(
      `cancellation verification attempt ${attempt} completed in ${Math.round(monotonicNow() - verificationStarted)}ms`,
    );
    for (const bookingId of [...pending]) {
      if (!confirmedIds.has(bookingId)) pending.delete(bookingId);
    }
    if (pending.size === 0) return bookingIds;
    if (attempt < attempts) await sleep(350 * attempt);
  }

  throw new CancellationError([...pending].sort((a, b) => a - b), attempts);
}

export interface ExecuteBookingTransactionOptions {
  activeBookings?: readonly BookingRecord[];
  maxSessions?: number;
  /** One pass matches immediate execution; two matches the scheduled runner. */
  warmupPasses?: 1 | 2;
  /** Scheduled runners use release minus three seconds for the second pass. */
  secondWarmupAt?: Date;
  fireAt?: Date;
  now?: () => Date;
  sleep?: Sleep;
  monotonicNow?: () => number;
  onTiming?: (message: string) => void;
}

export interface BookingTransactionResult {
  message: string;
  bookingOrderId: number | null;
  bookingOrderIds: number[];
  results: ConfirmedSubmission[];
  bookingTargets: BookingTarget[];
  cancelledBookingIds: number[];
  submitSkewMs: number;
  warmupElapsedMs: number[];
}

function clientsForTargets(
  client: BookingTransactionClient,
  count: number,
): BookingTransactionClient[] {
  return [
    client,
    ...Array.from({ length: Math.max(0, count - 1) }, () =>
      client.fork ? client.fork() : client,
    ),
  ];
}

async function warmClients(
  clients: readonly BookingTransactionClient[],
  pass: number,
  onTiming?: (message: string) => void,
): Promise<number[]> {
  const outcomes = await Promise.allSettled(
    clients.map((client) => client.warmup()),
  );
  const elapsed: number[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") {
      elapsed.push(outcome.value.elapsedMs);
    } else {
      onTiming?.(
        `warmup pass ${pass} warning: ${safeErrorMessage(outcome.reason)}`,
      );
    }
  }
  return elapsed;
}

async function sleepUntil(
  fireAt: Date,
  now: () => Date,
  sleep: Sleep,
): Promise<void> {
  const timestamp = fireAt.valueOf();
  if (!Number.isFinite(timestamp)) {
    throw new DomainError("The requested execution time is invalid.");
  }
  const delay = timestamp - now().valueOf();
  if (delay > 0) await sleep(delay);
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(safeErrorMessage(error) || "Unexpected booking error");
}

export async function executeBookingTransaction(
  client: BookingTransactionClient,
  schedule: Schedule,
  options: ExecuteBookingTransactionOptions = {},
): Promise<BookingTransactionResult> {
  const maxSessions = options.maxSessions ?? MAX_BOOKING_TARGETS;
  const history =
    options.activeBookings ??
    activeTennisBookings(await client.bookingHistory({ pageSize: 50 }));
  const active = activeTennisBookings(history);
  // This check and all target normalization complete before any cancellation.
  const prepared = prepareRebookingBatch(schedule, active, maxSessions);
  const clients = clientsForTargets(client, prepared.bookingTargets.length);
  const warmupElapsedMs: number[] = [];

  warmupElapsedMs.push(
    ...(await warmClients(clients, 1, options.onTiming)),
  );
  const cancelledBookingIds = active.length
    ? await cancelActiveTennisBookings(client, active, {
        sleep: options.sleep,
        monotonicNow: options.monotonicNow,
        onTiming: options.onTiming,
      })
    : [];

  const warmupPasses = options.warmupPasses ?? 1;
  if (warmupPasses === 2) {
    if (options.secondWarmupAt) {
      await sleepUntil(
        options.secondWarmupAt,
        options.now ?? (() => new Date()),
        options.sleep ?? defaultSleep,
      );
    }
    warmupElapsedMs.push(
      ...(await warmClients(clients, 2, options.onTiming)),
    );
  }

  const sleep = options.sleep ?? defaultSleep;
  if (options.fireAt) {
    await sleepUntil(options.fireAt, options.now ?? (() => new Date()), sleep);
  }

  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  const outcomes = await Promise.all(
    prepared.bookingTargets.map(async (target, index) => {
      const startedMs = monotonicNow();
      try {
        const result = await clients[index].createSingleBooking(
          singleTargetSchedule(prepared.schedule, target),
        );
        return {
          ok: true as const,
          target,
          result,
          startedMs,
        };
      } catch (error) {
        return {
          ok: false as const,
          target,
          error: toError(error),
          startedMs,
        };
      }
    }),
  );

  const results: ConfirmedSubmission[] = [];
  const failures: FailedSubmission[] = [];
  for (const outcome of outcomes) {
    if (outcome.ok) results.push(outcome);
    else failures.push(outcome);
  }
  const starts = outcomes.map((outcome) => outcome.startedMs);
  const submitSkewMs =
    starts.length > 1
      ? Math.round((Math.max(...starts) - Math.min(...starts)) * 1_000) / 1_000
      : 0;

  if (failures.length > 0) {
    if (results.length > 0) {
      throw new PartialBookingError(
        results,
        failures,
        submitSkewMs,
        cancelledBookingIds,
      );
    }
    if (cancelledBookingIds.length > 0) {
      throw new RebookingSubmissionError(
        cancelledBookingIds,
        failures[0].error,
      );
    }
    throw failures[0].error;
  }

  const bookingOrderIds = results
    .map((item) => item.result.bookingOrderId)
    .filter((id): id is number => id !== null);
  return {
    message: `${results.length} of ${prepared.bookingTargets.length} sessions confirmed`,
    bookingOrderId: bookingOrderIds[0] ?? null,
    bookingOrderIds,
    results,
    bookingTargets: prepared.bookingTargets,
    cancelledBookingIds,
    submitSkewMs,
    warmupElapsedMs,
  };
}
