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
  readonly failures: FailedSubmission[];
  readonly submitSkewMs: number;

  constructor(
    cancelledBookingIds: readonly number[],
    failures: readonly FailedSubmission[],
    submitSkewMs: number,
  ) {
    const targets = failures
      .map((failure) => `${failure.target.eventDay} ${failure.target.eventTime}`)
      .join(", ");
    const reasons = [
      ...new Set(failures.map((failure) => safeErrorMessage(failure.error))),
    ].join("; ");
    super(
      `Active bookings were cancelled, but no replacement request was confirmed. ${failures.length} request${failures.length === 1 ? "" : "s"} failed for ${targets}: ${reasons} Refresh booking history now.`,
    );
    this.name = "RebookingSubmissionError";
    this.cancelledBookingIds = [...cancelledBookingIds];
    this.failures = [...failures];
    this.submitSkewMs = submitSkewMs;
  }

  get bookingTargets(): BookingTarget[] {
    return this.failures.map((failure) => failure.target);
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
  /** Keep early preparation separate from the narrow destructive window. */
  cancelAt?: Date;
  /** Scheduled runners use release minus three seconds for the second pass. */
  secondWarmupAt?: Date;
  fireAt?: Date;
  /** Compensate transmission time so the request reaches Dooremi at release. */
  releaseAt?: Date;
  fireDelayMilliseconds?: number;
  maximumTransmissionLeadMilliseconds?: number;
  /** Retry only explicit JSON rejections, never ambiguous submissions. */
  rejectedSubmissionRetries?: number;
  rejectedSubmissionRetryDelayMilliseconds?: number;
  rejectedSubmissionRetryStaggerMilliseconds?: number;
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

export type CompensatedSubmissionTiming = {
  fireAt: Date;
  medianRoundTripMilliseconds: number | null;
  transmissionLeadMilliseconds: number;
};

export function compensatedSubmissionTiming(
  releaseAt: Date,
  fireDelayMilliseconds: number,
  roundTripSamples: readonly number[],
  maximumTransmissionLeadMilliseconds = 40,
): CompensatedSubmissionTiming {
  if (
    !Number.isFinite(releaseAt.valueOf()) ||
    !Number.isFinite(fireDelayMilliseconds) ||
    fireDelayMilliseconds < 0 ||
    !Number.isFinite(maximumTransmissionLeadMilliseconds) ||
    maximumTransmissionLeadMilliseconds < 0
  ) {
    throw new DomainError("The compensated submission timing is invalid.");
  }
  const samples = roundTripSamples
    .filter((sample) => Number.isFinite(sample) && sample >= 0)
    .sort((left, right) => left - right);
  const midpoint = Math.floor(samples.length / 2);
  const median = samples.length
    ? samples.length % 2 === 0
      ? (samples[midpoint - 1] + samples[midpoint]) / 2
      : samples[midpoint]
    : null;
  const transmissionLeadMilliseconds =
    median === null
      ? 0
      : Math.min(
          maximumTransmissionLeadMilliseconds,
          Math.max(0, Math.round(median / 2)),
        );
  return {
    fireAt: new Date(
      releaseAt.valueOf() +
        fireDelayMilliseconds -
        transmissionLeadMilliseconds,
    ),
    medianRoundTripMilliseconds: median,
    transmissionLeadMilliseconds,
  };
}

async function createSingleBookingWithSafeRetry(
  client: BookingTransactionClient,
  schedule: Schedule,
  target: BookingTarget,
  targetIndex: number,
  options: {
    retries: number;
    retryDelayMilliseconds: number;
    retryStaggerMilliseconds: number;
    sleep: Sleep;
    onTiming?: (message: string) => void;
  },
): Promise<SingleBookingResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.createSingleBooking(
        singleTargetSchedule(schedule, target),
      );
    } catch (error) {
      const normalized = toError(error);
      if (
        !(normalized instanceof DooremiError) ||
        normalized.code !== "rejected" ||
        attempt >= options.retries
      ) {
        throw normalized;
      }
      const delay =
        options.retryDelayMilliseconds +
        targetIndex * options.retryStaggerMilliseconds;
      options.onTiming?.(
        `explicit rejection for ${target.eventDay} ${target.eventTime}; safe retry ${attempt + 1} in ${delay}ms`,
      );
      if (delay > 0) await options.sleep(delay);
    }
  }
}

export async function executeBookingTransaction(
  client: BookingTransactionClient,
  schedule: Schedule,
  options: ExecuteBookingTransactionOptions = {},
): Promise<BookingTransactionResult> {
  const maxSessions = options.maxSessions ?? MAX_BOOKING_TARGETS;
  const rejectedSubmissionRetries = options.rejectedSubmissionRetries ?? 0;
  const rejectedSubmissionRetryDelayMilliseconds =
    options.rejectedSubmissionRetryDelayMilliseconds ?? 60;
  const rejectedSubmissionRetryStaggerMilliseconds =
    options.rejectedSubmissionRetryStaggerMilliseconds ?? 10;
  if (
    !Number.isSafeInteger(rejectedSubmissionRetries) ||
    rejectedSubmissionRetries < 0 ||
    rejectedSubmissionRetries > 2 ||
    !Number.isFinite(rejectedSubmissionRetryDelayMilliseconds) ||
    rejectedSubmissionRetryDelayMilliseconds < 0 ||
    !Number.isFinite(rejectedSubmissionRetryStaggerMilliseconds) ||
    rejectedSubmissionRetryStaggerMilliseconds < 0
  ) {
    throw new DomainError("The safe submission retry configuration is invalid.");
  }
  for (const executionTime of [
    options.cancelAt,
    options.secondWarmupAt,
    options.fireAt,
    options.releaseAt,
  ]) {
    if (executionTime && !Number.isFinite(executionTime.valueOf())) {
      throw new DomainError("The requested execution time is invalid.");
    }
  }
  if (options.releaseAt) {
    compensatedSubmissionTiming(
      options.releaseAt,
      options.fireDelayMilliseconds ?? 0,
      [],
      options.maximumTransmissionLeadMilliseconds,
    );
  }
  const history =
    options.activeBookings ??
    activeTennisBookings(await client.bookingHistory({ pageSize: 50 }));
  const active = activeTennisBookings(history);
  // This check and all target normalization complete before any cancellation.
  const prepared = prepareRebookingBatch(schedule, active, maxSessions);
  const clients = clientsForTargets(client, prepared.bookingTargets.length);
  const warmupElapsedMs: number[] = [];

  const firstWarmupElapsedMs = await warmClients(
    clients,
    1,
    options.onTiming,
  );
  warmupElapsedMs.push(...firstWarmupElapsedMs);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  if (active.length && options.cancelAt) {
    await sleepUntil(options.cancelAt, now, sleep);
    options.onTiming?.("configured cancellation window opened");
  }
  const cancelledBookingIds = active.length
    ? await cancelActiveTennisBookings(client, active, {
        sleep,
        monotonicNow: options.monotonicNow,
        onTiming: options.onTiming,
      })
    : [];

  const warmupPasses = options.warmupPasses ?? 1;
  let latestWarmupElapsedMs = firstWarmupElapsedMs;
  if (warmupPasses === 2) {
    if (options.secondWarmupAt) {
      await sleepUntil(options.secondWarmupAt, now, sleep);
    }
    const secondWarmupElapsedMs = await warmClients(
      clients,
      2,
      options.onTiming,
    );
    warmupElapsedMs.push(...secondWarmupElapsedMs);
    if (secondWarmupElapsedMs.length > 0) {
      latestWarmupElapsedMs = secondWarmupElapsedMs;
    }
  }

  let fireAt = options.fireAt;
  if (options.releaseAt) {
    const compensated = compensatedSubmissionTiming(
      options.releaseAt,
      options.fireDelayMilliseconds ?? 0,
      latestWarmupElapsedMs,
      options.maximumTransmissionLeadMilliseconds,
    );
    fireAt = compensated.fireAt;
    const offset = fireAt.valueOf() - options.releaseAt.valueOf();
    options.onTiming?.(
      `submission transmit scheduled at T${offset >= 0 ? "+" : ""}${offset}ms using ${compensated.medianRoundTripMilliseconds ?? "no"}ms median warmup RTT`,
    );
  }
  if (fireAt) {
    await sleepUntil(fireAt, now, sleep);
  }

  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  const outcomes = await Promise.all(
    prepared.bookingTargets.map(async (target, index) => {
      const startedMs = monotonicNow();
      try {
        const result = await createSingleBookingWithSafeRetry(
          clients[index],
          prepared.schedule,
          target,
          index,
          {
            retries: rejectedSubmissionRetries,
            retryDelayMilliseconds:
              rejectedSubmissionRetryDelayMilliseconds,
            retryStaggerMilliseconds:
              rejectedSubmissionRetryStaggerMilliseconds,
            sleep,
            onTiming: options.onTiming,
          },
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
        failures,
        submitSkewMs,
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
