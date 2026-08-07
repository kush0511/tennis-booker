import {
  MAX_BOOKING_TARGETS,
  DomainError,
  activeTennisBookings,
  normalizeBookingTargets,
  normalizeEventDay,
  singleTargetSchedule,
  type Availability,
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

export type FailureAvailabilityState = "available" | "booked" | "missing";

export interface FailureAvailabilityObservation {
  target: BookingTarget;
  state: FailureAvailabilityState;
}

function availabilityEvidenceMessage(
  observations: readonly FailureAvailabilityObservation[],
): string {
  if (observations.length === 0) return "";
  const available = observations.filter((item) => item.state === "available").length;
  const booked = observations.filter((item) => item.state === "booked").length;
  const missing = observations.filter((item) => item.state === "missing").length;
  return ` Post-failure availability showed ${booked} booked, ${available} still available${missing ? `, and ${missing} missing from the provider response` : ""}.`;
}

function sentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

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

export class LatencyPreflightError extends Error {
  readonly successfulProbes: number;
  readonly requiredProbes: number;

  constructor(successfulProbes: number, requiredProbes: number) {
    super(
      `Only ${successfulProbes} latency probe${successfulProbes === 1 ? "" : "s"} succeeded immediately before cancellation; ${requiredProbes} were required. No existing bookings were cancelled.`,
    );
    this.name = "LatencyPreflightError";
    this.successfulProbes = successfulProbes;
    this.requiredProbes = requiredProbes;
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
  readonly availabilityEvidence: FailureAvailabilityObservation[];

  constructor(
    results: readonly ConfirmedSubmission[],
    failures: readonly FailedSubmission[],
    submitSkewMs: number,
    cancelledBookingIds: readonly number[],
    availabilityEvidence: readonly FailureAvailabilityObservation[] = [],
  ) {
    super(
      `${results.length} of ${results.length + failures.length} requests returned a success. Refresh booking history before retrying; one or more requests failed or had an ambiguous response.${availabilityEvidenceMessage(availabilityEvidence)}`,
    );
    this.name = "PartialBookingError";
    this.results = [...results];
    this.failures = [...failures];
    this.submitSkewMs = submitSkewMs;
    this.cancelledBookingIds = [...cancelledBookingIds];
    this.availabilityEvidence = [...availabilityEvidence];
  }

  get bookingOrderIds(): number[] {
    return [
      ...new Set(
        this.results
          .map((item) => item.result.bookingOrderId)
          .filter((id): id is number => id !== null),
      ),
    ];
  }
}

export class BookingSubmissionError extends Error {
  readonly failures: FailedSubmission[];
  readonly submitSkewMs: number;
  readonly availabilityEvidence: FailureAvailabilityObservation[];

  constructor(
    failures: readonly FailedSubmission[],
    submitSkewMs: number,
    availabilityEvidence: readonly FailureAvailabilityObservation[] = [],
  ) {
    const targets = failures
      .map((failure) => `${failure.target.eventDay} ${failure.target.eventTime}`)
      .join(", ");
    const reasons = [
      ...new Set(failures.map((failure) => safeErrorMessage(failure.error))),
    ].join("; ");
    super(
      `No booking request was confirmed. ${failures.length} target${failures.length === 1 ? "" : "s"} failed for ${targets}: ${sentence(reasons)}${availabilityEvidenceMessage(availabilityEvidence)} Refresh booking history before trying again.`,
    );
    this.name = "BookingSubmissionError";
    this.failures = [...failures];
    this.submitSkewMs = submitSkewMs;
    this.availabilityEvidence = [...availabilityEvidence];
  }

  get bookingTargets(): BookingTarget[] {
    return this.failures.map((failure) => failure.target);
  }
}

export class RebookingSubmissionError extends Error {
  readonly cancelledBookingIds: number[];
  readonly failures: FailedSubmission[];
  readonly submitSkewMs: number;
  readonly availabilityEvidence: FailureAvailabilityObservation[];

  constructor(
    cancelledBookingIds: readonly number[],
    failures: readonly FailedSubmission[],
    submitSkewMs: number,
    availabilityEvidence: readonly FailureAvailabilityObservation[] = [],
  ) {
    const targets = failures
      .map((failure) => `${failure.target.eventDay} ${failure.target.eventTime}`)
      .join(", ");
    const reasons = [
      ...new Set(failures.map((failure) => safeErrorMessage(failure.error))),
    ].join("; ");
    super(
      `Active bookings were cancelled, but no replacement request was confirmed. ${failures.length} request${failures.length === 1 ? "" : "s"} failed for ${targets}: ${sentence(reasons)}${availabilityEvidenceMessage(availabilityEvidence)} Refresh booking history now.`,
    );
    this.name = "RebookingSubmissionError";
    this.cancelledBookingIds = [...cancelledBookingIds];
    this.failures = [...failures];
    this.submitSkewMs = submitSkewMs;
    this.availabilityEvidence = [...availabilityEvidence];
  }

  get bookingTargets(): BookingTarget[] {
    return this.failures.map((failure) => failure.target);
  }
}

export interface BookingTransactionClient {
  warmup(options?: { timeoutMs?: number }): Promise<WarmupResult>;
  bookingHistory(options?: {
    pageSize?: number;
    cursor?: string | number;
  }): Promise<BookingRecord[]>;
  cancelBooking(bookingId: number): Promise<CancelBookingResult>;
  createSingleBooking(schedule: Schedule): Promise<SingleBookingResult>;
  availability?(
    eventDay: string,
    facilityId: number,
    facilityCategoryId: number,
  ): Promise<Availability>;
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
  /** Scheduled runners use this boundary for near-release latency calibration. */
  secondWarmupAt?: Date;
  /** Read-only probes that must pass before any destructive cancellation. */
  preCancellationProbeCount?: number;
  preCancellationMinimumSuccesses?: number;
  /** Additional read-only samples collected close to the release boundary. */
  latencyProbeCount?: number;
  latencyProbeIntervalMilliseconds?: number;
  latencyProbeTimeoutMilliseconds?: number;
  latencyCalibrationCutoffMilliseconds?: number;
  latencyPercentile?: number;
  minimumLatencySamples?: number;
  fallbackRoundTripMilliseconds?: number;
  fireAt?: Date;
  /** Compensate transmission time so the request reaches Dooremi at release. */
  releaseAt?: Date;
  fireDelayMilliseconds?: number;
  maximumTransmissionLeadMilliseconds?: number;
  /** Never schedule the first transmit earlier than this many milliseconds. */
  maximumEarlySubmissionMilliseconds?: number;
  /** Retry only explicit JSON rejections, never ambiguous submissions. */
  rejectedSubmissionRetries?: number;
  rejectedSubmissionRetryDelayMilliseconds?: number;
  rejectedSubmissionRetryDelaysMilliseconds?: readonly number[];
  rejectedSubmissionRetryStaggerMilliseconds?: number;
  /** Poll history after an ambiguous response instead of blindly resubmitting. */
  ambiguousReconciliationDelaysMilliseconds?: readonly number[];
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
  timeoutMilliseconds?: number,
): Promise<number[]> {
  const outcomes = await Promise.allSettled(
    clients.map((client) => client.warmup({ timeoutMs: timeoutMilliseconds })),
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

interface LatencyProbeObservation {
  elapsedMs: number;
  receivedAtMs: number;
  serverDateMs: number | null;
}

interface LatencyProbeBatch {
  elapsedMs: number[];
  observations: LatencyProbeObservation[];
}

function providerDateEvidence(
  observations: readonly LatencyProbeObservation[],
  releaseAt?: Date,
): string | null {
  const dated = observations.filter(
    (item): item is LatencyProbeObservation & { serverDateMs: number } =>
      item.serverDateMs !== null,
  );
  if (dated.length === 0) return null;
  const maximumProvenLagMilliseconds = Math.max(
    0,
    ...dated.map(
      (item) => item.receivedAtMs - (item.serverDateMs + 999),
    ),
  );
  let regressions = 0;
  for (let index = 1; index < dated.length; index += 1) {
    if (dated[index].serverDateMs < dated[index - 1].serverDateMs) {
      regressions += 1;
    }
  }
  const releaseOffsets = releaseAt
    ? [
        ...new Set(
          dated.map(
            (item) => item.serverDateMs - releaseAt.valueOf(),
          ),
        ),
      ]
        .sort((left, right) => left - right)
        .map((offset) => `T${offset >= 0 ? "+" : ""}${offset}ms`)
        .join(", ")
    : null;
  return `${dated.length}/${observations.length} Date headers; maximum proven clock lag ${maximumProvenLagMilliseconds}ms; ${regressions} backward second transition${regressions === 1 ? "" : "s"}${releaseOffsets ? `; header seconds versus release ${releaseOffsets}` : ""}`;
}

async function collectLatencyProbes(
  client: BookingTransactionClient,
  options: {
    count: number;
    intervalMilliseconds: number;
    timeoutMilliseconds: number;
    sleep: Sleep;
    now: () => Date;
    deadline?: Date;
    releaseAt?: Date;
    label: string;
    onTiming?: (message: string) => void;
  },
): Promise<LatencyProbeBatch> {
  const elapsed: number[] = [];
  const observations: LatencyProbeObservation[] = [];
  for (let index = 0; index < options.count; index += 1) {
    const remaining = options.deadline
      ? options.deadline.valueOf() - options.now().valueOf()
      : Number.POSITIVE_INFINITY;
    if (remaining <= 50) {
      options.onTiming?.(
        `${options.label} stopped before probe ${index + 1}; the release safety cutoff was reached`,
      );
      break;
    }
    const timeoutMilliseconds = Math.max(
      25,
      Math.min(options.timeoutMilliseconds, remaining - 25),
    );
    try {
      const result = await client.warmup({ timeoutMs: timeoutMilliseconds });
      elapsed.push(result.elapsedMs);
      observations.push({
        elapsedMs: result.elapsedMs,
        receivedAtMs: options.now().valueOf(),
        serverDateMs: result.serverDate?.valueOf() ?? null,
      });
    } catch (error) {
      options.onTiming?.(
        `${options.label} probe ${index + 1} warning: ${safeErrorMessage(error)}`,
      );
    }
    if (index + 1 < options.count && options.intervalMilliseconds > 0) {
      const intervalRemaining = options.deadline
        ? options.deadline.valueOf() - options.now().valueOf()
        : Number.POSITIVE_INFINITY;
      if (intervalRemaining <= options.intervalMilliseconds + 50) break;
      await options.sleep(options.intervalMilliseconds);
    }
  }
  options.onTiming?.(
    `${options.label} collected ${elapsed.length}/${options.count} RTT samples${elapsed.length ? ` (${elapsed.join(", ")}ms)` : ""}`,
  );
  const dateEvidence = providerDateEvidence(observations, options.releaseAt);
  if (dateEvidence) {
    options.onTiming?.(`${options.label} provider clock evidence: ${dateEvidence}`);
  }
  return { elapsedMs: elapsed, observations };
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
  calibratedRoundTripMilliseconds: number;
  latencyPercentile: number;
  sampleCount: number;
  usedFallback: boolean;
  uncappedTransmissionLeadMilliseconds: number;
  transmissionLeadMilliseconds: number;
  earlyTransmissionCapped: boolean;
};

export type SubmissionTimingPolicy = {
  maximumTransmissionLeadMilliseconds?: number;
  maximumEarlySubmissionMilliseconds?: number;
  latencyPercentile?: number;
  minimumSampleCount?: number;
  fallbackRoundTripMilliseconds?: number;
};

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

export function compensatedSubmissionTiming(
  releaseAt: Date,
  fireDelayMilliseconds: number,
  roundTripSamples: readonly number[],
  policy: SubmissionTimingPolicy = {},
): CompensatedSubmissionTiming {
  const maximumTransmissionLeadMilliseconds =
    policy.maximumTransmissionLeadMilliseconds ?? 250;
  const maximumEarlySubmissionMilliseconds =
    policy.maximumEarlySubmissionMilliseconds ?? Number.POSITIVE_INFINITY;
  const latencyPercentile = policy.latencyPercentile ?? 0.75;
  const minimumSampleCount = policy.minimumSampleCount ?? 5;
  const fallbackRoundTripMilliseconds =
    policy.fallbackRoundTripMilliseconds ?? 120;
  if (
    !Number.isFinite(releaseAt.valueOf()) ||
    !Number.isFinite(fireDelayMilliseconds) ||
    fireDelayMilliseconds < 0 ||
    !Number.isFinite(maximumTransmissionLeadMilliseconds) ||
    maximumTransmissionLeadMilliseconds < 0 ||
    (maximumEarlySubmissionMilliseconds !== Number.POSITIVE_INFINITY &&
      (!Number.isFinite(maximumEarlySubmissionMilliseconds) ||
        maximumEarlySubmissionMilliseconds < 0)) ||
    !Number.isFinite(latencyPercentile) ||
    latencyPercentile < 0.5 ||
    latencyPercentile > 1 ||
    !Number.isSafeInteger(minimumSampleCount) ||
    minimumSampleCount < 1 ||
    !Number.isFinite(fallbackRoundTripMilliseconds) ||
    fallbackRoundTripMilliseconds < 0
  ) {
    throw new DomainError("The compensated submission timing is invalid.");
  }
  const samples = roundTripSamples
    .filter((sample) => Number.isFinite(sample) && sample >= 0)
    .sort((left, right) => left - right);
  const median = percentile(samples, 0.5);
  const measured = percentile(samples, latencyPercentile);
  const usedFallback = samples.length < minimumSampleCount;
  const calibratedRoundTripMilliseconds = Math.max(
    measured ?? 0,
    usedFallback ? fallbackRoundTripMilliseconds : 0,
  );
  const uncappedTransmissionLeadMilliseconds = Math.min(
    maximumTransmissionLeadMilliseconds,
    Math.max(0, Math.round(calibratedRoundTripMilliseconds / 2)),
  );
  const transmissionLeadMilliseconds = Math.min(
    uncappedTransmissionLeadMilliseconds,
    fireDelayMilliseconds + maximumEarlySubmissionMilliseconds,
  );
  return {
    fireAt: new Date(
      releaseAt.valueOf() +
        fireDelayMilliseconds -
        transmissionLeadMilliseconds,
    ),
    medianRoundTripMilliseconds: median,
    calibratedRoundTripMilliseconds,
    latencyPercentile,
    sampleCount: samples.length,
    usedFallback,
    uncappedTransmissionLeadMilliseconds,
    transmissionLeadMilliseconds,
    earlyTransmissionCapped:
      transmissionLeadMilliseconds < uncappedTransmissionLeadMilliseconds,
  };
}

async function createSingleBookingWithSafeRetry(
  client: BookingTransactionClient,
  schedule: Schedule,
  target: BookingTarget,
  targetIndex: number,
  options: {
    retryDelaysMilliseconds: readonly number[];
    retryStaggerMilliseconds: number;
    sleep: Sleep;
    now: () => Date;
    monotonicNow: () => number;
    releaseAt?: Date;
    onTiming?: (message: string) => void;
  },
): Promise<SingleBookingResult> {
  for (let attempt = 0; ; attempt += 1) {
    const started = options.monotonicNow();
    const startedOffset = options.releaseAt
      ? options.now().valueOf() - options.releaseAt.valueOf()
      : null;
    options.onTiming?.(
      `booking attempt ${attempt + 1}/${options.retryDelaysMilliseconds.length + 1} for ${target.eventDay} ${target.eventTime} transmitted${startedOffset === null ? "" : ` at T${startedOffset >= 0 ? "+" : ""}${Math.round(startedOffset)}ms`}`,
    );
    try {
      const result = await client.createSingleBooking(
        singleTargetSchedule(schedule, target),
      );
      options.onTiming?.(
        `booking attempt ${attempt + 1} for ${target.eventDay} ${target.eventTime} confirmed in ${Math.round(options.monotonicNow() - started)}ms${result.bookingOrderId === null ? "" : ` as order ${result.bookingOrderId}`}`,
      );
      return result;
    } catch (error) {
      const normalized = toError(error);
      const elapsed = Math.round(options.monotonicNow() - started);
      const providerDateOffset =
        normalized instanceof DooremiError &&
        normalized.serverDate &&
        options.releaseAt
          ? normalized.serverDate.valueOf() - options.releaseAt.valueOf()
          : null;
      const providerClockDetail =
        providerDateOffset === null
          ? ""
          : `; provider Date-header second T${providerDateOffset >= 0 ? "+" : ""}${providerDateOffset}ms`;
      if (
        !(normalized instanceof DooremiError) ||
        normalized.code !== "rejected" ||
        attempt >= options.retryDelaysMilliseconds.length
      ) {
        options.onTiming?.(
          `booking attempt ${attempt + 1} for ${target.eventDay} ${target.eventTime} ended in ${elapsed}ms with ${normalized instanceof DooremiError ? normalized.code : "unexpected_error"}${providerClockDetail}: ${safeErrorMessage(normalized)}`,
        );
        throw normalized;
      }
      const delay =
        options.retryDelaysMilliseconds[attempt] +
        targetIndex * options.retryStaggerMilliseconds;
      options.onTiming?.(
        `explicit rejection for ${target.eventDay} ${target.eventTime} returned in ${elapsed}ms${providerClockDetail}; safe retry ${attempt + 1}/${options.retryDelaysMilliseconds.length} in ${delay}ms`,
      );
      if (delay > 0) await options.sleep(delay);
    }
  }
}

function bookingMatchesTarget(
  booking: BookingRecord,
  target: BookingTarget,
): boolean {
  try {
    return (
      normalizeEventDay(booking.eventDay) === target.eventDay &&
      booking.eventTimes.includes(target.eventTime)
    );
  } catch {
    return false;
  }
}

async function reconcileAmbiguousFailures(
  client: BookingTransactionClient,
  failures: readonly FailedSubmission[],
  options: {
    delaysMilliseconds: readonly number[];
    sleep: Sleep;
    onTiming?: (message: string) => void;
  },
): Promise<{
  confirmed: ConfirmedSubmission[];
  unresolved: FailedSubmission[];
}> {
  const unresolved = new Map(
    failures
      .filter(
        (failure) =>
          failure.error instanceof DooremiError &&
          failure.error.code === "ambiguous_submission",
      )
      .map((failure) => [failure.target.eventDay + " " + failure.target.eventTime, failure]),
  );
  const confirmed: ConfirmedSubmission[] = [];
  if (unresolved.size === 0 || options.delaysMilliseconds.length === 0) {
    return { confirmed, unresolved: [...failures] };
  }

  let previousOffsetMilliseconds = 0;
  for (let index = 0; index < options.delaysMilliseconds.length; index += 1) {
    const offsetMilliseconds = options.delaysMilliseconds[index];
    const delay = Math.max(
      0,
      offsetMilliseconds - previousOffsetMilliseconds,
    );
    if (delay > 0) await options.sleep(delay);
    previousOffsetMilliseconds = offsetMilliseconds;
    let history: BookingRecord[];
    try {
      history = activeTennisBookings(
        await client.bookingHistory({ pageSize: 50 }),
      );
    } catch (error) {
      options.onTiming?.(
        `ambiguous submission reconciliation ${index + 1}/${options.delaysMilliseconds.length} warning: ${safeErrorMessage(error)}`,
      );
      continue;
    }
    for (const [key, failure] of unresolved) {
      const booking = history.find((item) =>
        bookingMatchesTarget(item, failure.target),
      );
      if (!booking) continue;
      confirmed.push({
        target: failure.target,
        result: {
          message: "Confirmed from booking history after an ambiguous response",
          bookingOrderId: booking.id,
        },
        startedMs: failure.startedMs,
      });
      unresolved.delete(key);
      options.onTiming?.(
        `ambiguous response for ${failure.target.eventDay} ${failure.target.eventTime} reconciled as booking ${booking.id}`,
      );
    }
    if (unresolved.size === 0) break;
  }

  const unresolvedAmbiguous = new Set(unresolved.values());
  return {
    confirmed,
    unresolved: failures.filter(
      (failure) =>
        !(failure.error instanceof DooremiError) ||
        failure.error.code !== "ambiguous_submission" ||
        unresolvedAmbiguous.has(failure),
    ),
  };
}

async function reconcileFinalFailuresFromHistory(
  client: BookingTransactionClient,
  failures: readonly FailedSubmission[],
  onTiming?: (message: string) => void,
): Promise<{
  confirmed: ConfirmedSubmission[];
  unresolved: FailedSubmission[];
}> {
  if (failures.length === 0) return { confirmed: [], unresolved: [] };
  let history: BookingRecord[];
  try {
    history = activeTennisBookings(
      await client.bookingHistory({ pageSize: 50 }),
    );
  } catch (error) {
    onTiming?.(
      `final booking-history reconciliation warning: ${safeErrorMessage(error)}`,
    );
    return { confirmed: [], unresolved: [...failures] };
  }
  const confirmed: ConfirmedSubmission[] = [];
  const unresolved: FailedSubmission[] = [];
  for (const failure of failures) {
    const booking = history.find((item) =>
      bookingMatchesTarget(item, failure.target),
    );
    if (!booking) {
      unresolved.push(failure);
      continue;
    }
    confirmed.push({
      target: failure.target,
      result: {
        message: "Confirmed from booking history after the provider response",
        bookingOrderId: booking.id,
      },
      startedMs: failure.startedMs,
    });
    onTiming?.(
      `final history reconciliation confirmed ${failure.target.eventDay} ${failure.target.eventTime} as booking ${booking.id}`,
    );
  }
  return { confirmed, unresolved };
}

async function inspectFailureAvailability(
  client: BookingTransactionClient,
  schedule: Schedule,
  failures: readonly FailedSubmission[],
  onTiming?: (message: string) => void,
): Promise<FailureAvailabilityObservation[]> {
  if (!client.availability || !schedule.facilityCategoryId) return [];
  const rejected = failures.filter(
    (failure) =>
      failure.error instanceof DooremiError &&
      failure.error.code === "rejected",
  );
  const groups = new Map<string, FailedSubmission[]>();
  for (const failure of rejected) {
    const key = `${failure.target.eventDay}\u0000${failure.target.facilityId}`;
    const group = groups.get(key) ?? [];
    group.push(failure);
    groups.set(key, group);
  }
  const observations: FailureAvailabilityObservation[] = [];
  for (const group of groups.values()) {
    const first = group[0].target;
    let availability: Availability;
    try {
      availability = await client.availability(
        first.eventDay,
        first.facilityId,
        schedule.facilityCategoryId,
      );
    } catch (error) {
      onTiming?.(
        `post-failure availability warning for ${first.eventDay}: ${safeErrorMessage(error)}`,
      );
      continue;
    }
    for (const failure of group) {
      const slot = availability.slots.find(
        (item) =>
          item.facilityId === failure.target.facilityId &&
          item.eventTime === failure.target.eventTime,
      );
      const state: FailureAvailabilityState = slot
        ? slot.available
          ? "available"
          : "booked"
        : "missing";
      observations.push({ target: failure.target, state });
      onTiming?.(
        `post-failure availability for ${failure.target.eventDay} ${failure.target.eventTime}: ${state}`,
      );
    }
  }
  return observations;
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
  const rejectedSubmissionRetryDelaysMilliseconds =
    options.rejectedSubmissionRetryDelaysMilliseconds === undefined
      ? Array.from(
          { length: rejectedSubmissionRetries },
          () => rejectedSubmissionRetryDelayMilliseconds,
        )
      : [...options.rejectedSubmissionRetryDelaysMilliseconds];
  const rejectedSubmissionRetryStaggerMilliseconds =
    options.rejectedSubmissionRetryStaggerMilliseconds ?? 10;
  const preCancellationProbeCount =
    options.preCancellationProbeCount ?? 0;
  const preCancellationMinimumSuccesses =
    options.preCancellationMinimumSuccesses ?? 0;
  const latencyProbeCount = options.latencyProbeCount ?? 0;
  const latencyProbeIntervalMilliseconds =
    options.latencyProbeIntervalMilliseconds ?? 75;
  const latencyProbeTimeoutMilliseconds =
    options.latencyProbeTimeoutMilliseconds ?? 500;
  const latencyCalibrationCutoffMilliseconds =
    options.latencyCalibrationCutoffMilliseconds ?? 1_500;
  const minimumLatencySamples = options.minimumLatencySamples ?? 5;
  const ambiguousReconciliationDelaysMilliseconds = [
    ...(options.ambiguousReconciliationDelaysMilliseconds ?? []),
  ];
  if (
    !Number.isSafeInteger(rejectedSubmissionRetries) ||
    rejectedSubmissionRetries < 0 ||
    rejectedSubmissionRetries > 6 ||
    !Number.isFinite(rejectedSubmissionRetryDelayMilliseconds) ||
    rejectedSubmissionRetryDelayMilliseconds < 0 ||
    rejectedSubmissionRetryDelaysMilliseconds.length > 6 ||
    rejectedSubmissionRetryDelaysMilliseconds.some(
      (delay) => !Number.isFinite(delay) || delay < 0 || delay > 5_000,
    ) ||
    !Number.isFinite(rejectedSubmissionRetryStaggerMilliseconds) ||
    rejectedSubmissionRetryStaggerMilliseconds < 0 ||
    !Number.isSafeInteger(preCancellationProbeCount) ||
    preCancellationProbeCount < 0 ||
    preCancellationProbeCount > 10 ||
    !Number.isSafeInteger(preCancellationMinimumSuccesses) ||
    preCancellationMinimumSuccesses < 0 ||
    preCancellationMinimumSuccesses > preCancellationProbeCount ||
    !Number.isSafeInteger(latencyProbeCount) ||
    latencyProbeCount < 0 ||
    latencyProbeCount > 10 ||
    !Number.isFinite(latencyProbeIntervalMilliseconds) ||
    latencyProbeIntervalMilliseconds < 0 ||
    latencyProbeIntervalMilliseconds > 2_000 ||
    !Number.isFinite(latencyProbeTimeoutMilliseconds) ||
    latencyProbeTimeoutMilliseconds < 25 ||
    latencyProbeTimeoutMilliseconds > 5_000 ||
    !Number.isFinite(latencyCalibrationCutoffMilliseconds) ||
    latencyCalibrationCutoffMilliseconds < 250 ||
    latencyCalibrationCutoffMilliseconds > 10_000 ||
    ambiguousReconciliationDelaysMilliseconds.length > 6 ||
    ambiguousReconciliationDelaysMilliseconds.some(
      (delay) => !Number.isFinite(delay) || delay < 0 || delay > 5_000,
    ) ||
    ambiguousReconciliationDelaysMilliseconds.some(
      (delay, index) =>
        index > 0 &&
        delay < ambiguousReconciliationDelaysMilliseconds[index - 1],
    )
  ) {
    throw new DomainError("The booking timing or retry configuration is invalid.");
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
      {
        maximumTransmissionLeadMilliseconds:
          options.maximumTransmissionLeadMilliseconds,
        maximumEarlySubmissionMilliseconds:
          options.maximumEarlySubmissionMilliseconds,
        latencyPercentile: options.latencyPercentile,
        minimumSampleCount: minimumLatencySamples,
        fallbackRoundTripMilliseconds:
          options.fallbackRoundTripMilliseconds,
      },
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
  let preCancellationProbeElapsedMs: number[] = [];
  if (active.length && options.cancelAt) {
    await sleepUntil(options.cancelAt, now, sleep);
    options.onTiming?.("configured cancellation window opened");
    if (preCancellationProbeCount > 0) {
      const preCancellationProbes = await collectLatencyProbes(clients[0], {
        count: preCancellationProbeCount,
        intervalMilliseconds: latencyProbeIntervalMilliseconds,
        timeoutMilliseconds: latencyProbeTimeoutMilliseconds,
        sleep,
        now,
        label: "pre-cancellation latency gate",
        onTiming: options.onTiming,
      });
      preCancellationProbeElapsedMs = preCancellationProbes.elapsedMs;
      warmupElapsedMs.push(...preCancellationProbeElapsedMs);
      if (
        preCancellationProbeElapsedMs.length <
        preCancellationMinimumSuccesses
      ) {
        throw new LatencyPreflightError(
          preCancellationProbeElapsedMs.length,
          preCancellationMinimumSuccesses,
        );
      }
    }
  }
  const cancelledBookingIds = active.length
    ? await cancelActiveTennisBookings(client, active, {
        sleep,
        monotonicNow: options.monotonicNow,
        onTiming: options.onTiming,
      })
    : [];

  const warmupPasses = options.warmupPasses ?? 1;
  let latestWarmupElapsedMs = [
    ...firstWarmupElapsedMs,
    ...preCancellationProbeElapsedMs,
  ];
  if (warmupPasses === 2) {
    if (options.secondWarmupAt) {
      await sleepUntil(options.secondWarmupAt, now, sleep);
    }
    let calibrationElapsedMs: number[] = [];
    if (latencyProbeCount > 0) {
      const deadline = options.releaseAt
        ? new Date(
            options.releaseAt.valueOf() -
              latencyCalibrationCutoffMilliseconds,
          )
        : undefined;
      const calibrationProbes = await collectLatencyProbes(clients[0], {
        count: latencyProbeCount,
        intervalMilliseconds: latencyProbeIntervalMilliseconds,
        timeoutMilliseconds: latencyProbeTimeoutMilliseconds,
        sleep,
        now,
        deadline,
        releaseAt: options.releaseAt,
        label: "release latency calibration",
        onTiming: options.onTiming,
      });
      calibrationElapsedMs = calibrationProbes.elapsedMs;
      warmupElapsedMs.push(...calibrationElapsedMs);
    }
    const remainingBeforeRelease = options.releaseAt
      ? options.releaseAt.valueOf() - now().valueOf()
      : Number.POSITIVE_INFINITY;
    const secondWarmupElapsedMs =
      remainingBeforeRelease > latencyProbeTimeoutMilliseconds + 250
        ? await warmClients(
            clients,
            2,
            options.onTiming,
            latencyProbeTimeoutMilliseconds,
          )
        : [];
    if (
      options.releaseAt &&
      remainingBeforeRelease <= latencyProbeTimeoutMilliseconds + 250
    ) {
      options.onTiming?.(
        `final warmup skipped with ${Math.max(0, Math.round(remainingBeforeRelease))}ms remaining; preserving the calibrated transmit boundary`,
      );
    }
    warmupElapsedMs.push(...secondWarmupElapsedMs);
    const nearReleaseSamples = [
      ...calibrationElapsedMs,
      ...secondWarmupElapsedMs,
    ];
    const releaseSamples =
      nearReleaseSamples.length >= minimumLatencySamples
        ? nearReleaseSamples
        : [...preCancellationProbeElapsedMs, ...nearReleaseSamples];
    if (releaseSamples.length > 0) {
      latestWarmupElapsedMs = releaseSamples;
    }
  }

  let fireAt = options.fireAt;
  if (options.releaseAt) {
    const compensated = compensatedSubmissionTiming(
      options.releaseAt,
      options.fireDelayMilliseconds ?? 0,
      latestWarmupElapsedMs,
      {
        maximumTransmissionLeadMilliseconds:
          options.maximumTransmissionLeadMilliseconds,
        maximumEarlySubmissionMilliseconds:
          options.maximumEarlySubmissionMilliseconds,
        latencyPercentile: options.latencyPercentile,
        minimumSampleCount: minimumLatencySamples,
        fallbackRoundTripMilliseconds:
          options.fallbackRoundTripMilliseconds,
      },
    );
    fireAt = compensated.fireAt;
    const offset = fireAt.valueOf() - options.releaseAt.valueOf();
    options.onTiming?.(
      `submission transmit scheduled at T${offset >= 0 ? "+" : ""}${offset}ms from ${compensated.sampleCount} samples: p${Math.round(compensated.latencyPercentile * 100)} RTT ${Math.round(compensated.calibratedRoundTripMilliseconds)}ms, median ${compensated.medianRoundTripMilliseconds === null ? "n/a" : `${Math.round(compensated.medianRoundTripMilliseconds)}ms`}, applied lead ${compensated.transmissionLeadMilliseconds}ms${compensated.earlyTransmissionCapped ? ` (uncapped estimate ${compensated.uncappedTransmissionLeadMilliseconds}ms; early-send guard applied)` : ""}${compensated.usedFallback ? " (fallback floor applied)" : ""}`,
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
            retryDelaysMilliseconds:
              rejectedSubmissionRetryDelaysMilliseconds,
            retryStaggerMilliseconds:
              rejectedSubmissionRetryStaggerMilliseconds,
            sleep,
            now,
            monotonicNow,
            releaseAt: options.releaseAt,
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
  if (
    failures.some(
      (failure) =>
        failure.error instanceof DooremiError &&
        failure.error.code === "ambiguous_submission",
    ) &&
    ambiguousReconciliationDelaysMilliseconds.length > 0
  ) {
    const reconciled = await reconcileAmbiguousFailures(client, failures, {
      delaysMilliseconds: ambiguousReconciliationDelaysMilliseconds,
      sleep,
      onTiming: options.onTiming,
    });
    results.push(...reconciled.confirmed);
    failures.length = 0;
    failures.push(...reconciled.unresolved);
  }
  const finalReconciliationCandidates = failures.filter(
    (failure) =>
      failure.error instanceof DooremiError &&
      failure.error.code === "rejected",
  );
  if (finalReconciliationCandidates.length > 0) {
    const untouchedFailures = failures.filter(
      (failure) => !finalReconciliationCandidates.includes(failure),
    );
    const reconciled = await reconcileFinalFailuresFromHistory(
      client,
      finalReconciliationCandidates,
      options.onTiming,
    );
    results.push(...reconciled.confirmed);
    failures.length = 0;
    failures.push(...untouchedFailures, ...reconciled.unresolved);
  }
  const starts = outcomes.map((outcome) => outcome.startedMs);
  const submitSkewMs =
    starts.length > 1
      ? Math.round((Math.max(...starts) - Math.min(...starts)) * 1_000) / 1_000
      : 0;

  if (failures.length > 0) {
    const availabilityEvidence = await inspectFailureAvailability(
      client,
      prepared.schedule,
      failures,
      options.onTiming,
    );
    if (results.length > 0) {
      throw new PartialBookingError(
        results,
        failures,
        submitSkewMs,
        cancelledBookingIds,
        availabilityEvidence,
      );
    }
    if (cancelledBookingIds.length > 0) {
      throw new RebookingSubmissionError(
        cancelledBookingIds,
        failures,
        submitSkewMs,
        availabilityEvidence,
      );
    }
    throw new BookingSubmissionError(
      failures,
      submitSkewMs,
      availabilityEvidence,
    );
  }

  const bookingOrderIds = [
    ...new Set(
      results
        .map((item) => item.result.bookingOrderId)
        .filter((id): id is number => id !== null),
    ),
  ];
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
