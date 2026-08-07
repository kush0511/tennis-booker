import { appendScheduleEvent, finishSchedule, type StoredSchedule } from "@/db/repository";
import { releaseAt, type Config, type Schedule } from "@/lib/domain";
import { dooremiClient, HttpError } from "./api";
import {
  BookingSubmissionError,
  CancellationError,
  PartialBookingError,
  RebookingSubmissionError,
  executeBookingTransaction,
  type BookingTransactionResult,
} from "@/lib/transaction";
import { safeErrorMessage } from "@/lib/dooremi";
import { DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS } from "@/lib/dooremi-session";
import {
  effectiveHostedPreparationLead,
  HOSTED_AMBIGUOUS_RECONCILIATION_DELAYS_MILLISECONDS,
  HOSTED_FALLBACK_ROUND_TRIP_MILLISECONDS,
  HOSTED_LATENCY_CALIBRATION_CUTOFF_MILLISECONDS,
  HOSTED_LATENCY_CALIBRATION_LEAD_MILLISECONDS,
  HOSTED_LATENCY_PERCENTILE,
  HOSTED_LATENCY_PROBE_COUNT,
  HOSTED_LATENCY_PROBE_INTERVAL_MILLISECONDS,
  HOSTED_LATENCY_PROBE_TIMEOUT_MILLISECONDS,
  HOSTED_MAXIMUM_EARLY_SUBMISSION_MILLISECONDS,
  HOSTED_MAX_TRANSMISSION_LEAD_MILLISECONDS,
  HOSTED_MINIMUM_LATENCY_SAMPLES,
  HOSTED_PRE_CANCELLATION_MINIMUM_SUCCESSES,
  HOSTED_PRE_CANCELLATION_PROBE_COUNT,
  HOSTED_REJECTED_SUBMISSION_RETRY_DELAYS_MILLISECONDS,
  HOSTED_REJECTED_SUBMISSION_RETRY_STAGGER_MILLISECONDS,
} from "@/lib/automation";

export type ExecutionResult = {
  status: "succeeded" | "partial" | "failed" | "missed";
  message: string;
  bookingOrderIds: number[];
  bookingTargets: unknown[];
  cancelledBookingIds: number[];
  submitSkewMs: number | null;
};

export function domainSchedule(
  eventDay: string,
  eventTimes: readonly string[],
  settings: {
    facilityId: number;
    facilityCategoryId: number;
  },
): Schedule {
  return {
    eventDay,
    eventTimes,
    facilityId: settings.facilityId,
    facilityCategoryId: settings.facilityCategoryId,
  };
}

export function domainConfig(settings: {
  facilityId: number;
  facilityCategoryId: number;
  bookingLeadDays: number;
  releaseHour: number;
  releaseMinute: number;
  cancellationLeadSeconds: number;
  fireDelayMilliseconds: number;
  maximumSessions: number;
}): Config {
  return {
    facilityId: settings.facilityId,
    facilityCategoryId: settings.facilityCategoryId,
    bookingLeadDays: settings.bookingLeadDays,
    releaseHour: settings.releaseHour,
    releaseMinute: settings.releaseMinute,
    cancellationLeadSeconds: settings.cancellationLeadSeconds,
    fireDelayMilliseconds: settings.fireDelayMilliseconds,
    maxSessionsPerBooking: settings.maximumSessions,
  };
}

export async function executeImmediate(
  schedule: Schedule,
  config: Config,
): Promise<ExecutionResult> {
  const client = await dooremiClient({
    freshWithinMilliseconds: DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS,
    requireManagedRefresh: true,
  });
  const result = await executeBookingTransaction(client, schedule, {
    maxSessions: config.maxSessionsPerBooking,
    warmupPasses: 1,
  });
  return successfulResult(result);
}

export async function executeStoredSchedule(
  stored: StoredSchedule,
  config: Config,
): Promise<ExecutionResult> {
  const now = new Date();
  const release = new Date(stored.releaseAt);
  const secondsUntilRelease = (release.valueOf() - now.valueOf()) / 1000;
  if (secondsUntilRelease > 240) {
    throw new HttpError(409, "That schedule is not inside its arming window yet.");
  }
  if (secondsUntilRelease < -300) {
    const result: ExecutionResult = {
      status: "missed",
      message: "The hosted runner did not start within the five-minute grace period.",
      bookingOrderIds: [],
      bookingTargets: [],
      cancelledBookingIds: [],
      submitSkewMs: null,
    };
    await finishSchedule(stored.id, {
      status: result.status,
      resultMessage: result.message,
    });
    return result;
  }

  const preparationLeadSeconds = effectiveHostedPreparationLead(
    config.cancellationLeadSeconds,
  );
  const preparationAt = release.valueOf() - preparationLeadSeconds * 1_000;
  const preparationDelay = preparationAt - Date.now();
  if (preparationDelay > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, preparationDelay));
  }

  const schedule = domainSchedule(stored.eventDay, stored.eventTimes, {
    facilityId: stored.facilityId,
    facilityCategoryId: stored.facilityCategoryId,
  });
  const timingWrites: Promise<void>[] = [];
  const timing = (message: string) => {
    timingWrites.push(
      appendScheduleEvent(stored.id, stored.userEmail, "info", message).catch(
        () => undefined,
      ),
    );
  };
  timing(
    `hosted preparation started at T-${preparationLeadSeconds}s; cancellation remains at T-${config.cancellationLeadSeconds}s`,
  );

  try {
    const client = await dooremiClient({
      freshWithinMilliseconds: DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS,
      requireManagedRefresh: true,
    });
    const result = await executeBookingTransaction(client, schedule, {
      maxSessions: config.maxSessionsPerBooking,
      warmupPasses: 2,
      cancelAt: new Date(
        release.valueOf() - config.cancellationLeadSeconds * 1_000,
      ),
      secondWarmupAt: new Date(
        release.valueOf() - HOSTED_LATENCY_CALIBRATION_LEAD_MILLISECONDS,
      ),
      preCancellationProbeCount: HOSTED_PRE_CANCELLATION_PROBE_COUNT,
      preCancellationMinimumSuccesses:
        HOSTED_PRE_CANCELLATION_MINIMUM_SUCCESSES,
      latencyProbeCount: HOSTED_LATENCY_PROBE_COUNT,
      latencyProbeIntervalMilliseconds:
        HOSTED_LATENCY_PROBE_INTERVAL_MILLISECONDS,
      latencyProbeTimeoutMilliseconds:
        HOSTED_LATENCY_PROBE_TIMEOUT_MILLISECONDS,
      latencyCalibrationCutoffMilliseconds:
        HOSTED_LATENCY_CALIBRATION_CUTOFF_MILLISECONDS,
      latencyPercentile: HOSTED_LATENCY_PERCENTILE,
      minimumLatencySamples: HOSTED_MINIMUM_LATENCY_SAMPLES,
      fallbackRoundTripMilliseconds:
        HOSTED_FALLBACK_ROUND_TRIP_MILLISECONDS,
      releaseAt: release,
      fireDelayMilliseconds: config.fireDelayMilliseconds,
      maximumTransmissionLeadMilliseconds:
        HOSTED_MAX_TRANSMISSION_LEAD_MILLISECONDS,
      maximumEarlySubmissionMilliseconds:
        HOSTED_MAXIMUM_EARLY_SUBMISSION_MILLISECONDS,
      rejectedSubmissionRetryDelaysMilliseconds:
        HOSTED_REJECTED_SUBMISSION_RETRY_DELAYS_MILLISECONDS,
      rejectedSubmissionRetryStaggerMilliseconds:
        HOSTED_REJECTED_SUBMISSION_RETRY_STAGGER_MILLISECONDS,
      ambiguousReconciliationDelaysMilliseconds:
        HOSTED_AMBIGUOUS_RECONCILIATION_DELAYS_MILLISECONDS,
      onTiming: timing,
    });
    const completed = successfulResult(result);
    await finishSchedule(stored.id, {
      status: "succeeded",
      resultMessage: completed.message,
      bookingOrderIds: completed.bookingOrderIds,
      preparedTargets: completed.bookingTargets,
      submittedTargets: completed.bookingTargets,
      cancelledBookingIds: completed.cancelledBookingIds,
      submitSkewMs: completed.submitSkewMs,
    });
    return completed;
  } catch (error) {
    const message = safeErrorMessage(error);
    if (error instanceof PartialBookingError) {
      const targets = [...error.results, ...error.failures].map(
        (item) => item.target,
      );
      const partial: ExecutionResult = {
        status: "partial",
        message,
        bookingOrderIds: error.bookingOrderIds,
        bookingTargets: targets,
        cancelledBookingIds: error.cancelledBookingIds,
        submitSkewMs: error.submitSkewMs,
      };
      await finishSchedule(stored.id, {
        status: "partial",
        resultMessage: message,
        bookingOrderIds: partial.bookingOrderIds,
        preparedTargets: targets,
        submittedTargets: targets,
        cancelledBookingIds: partial.cancelledBookingIds,
        submitSkewMs: partial.submitSkewMs,
      });
      return partial;
    }

    const cancelledBookingIds =
      error instanceof RebookingSubmissionError
        ? error.cancelledBookingIds
        : [];
    const failedTargets =
      error instanceof RebookingSubmissionError ||
      error instanceof BookingSubmissionError
        ? error.bookingTargets
        : [];
    const submitSkewMs =
      error instanceof RebookingSubmissionError ||
      error instanceof BookingSubmissionError
        ? error.submitSkewMs
        : null;
    await finishSchedule(stored.id, {
      status: "failed",
      resultMessage: message,
      preparedTargets: failedTargets,
      submittedTargets: failedTargets,
      cancelledBookingIds,
      submitSkewMs,
    });
    await appendScheduleEvent(stored.id, stored.userEmail, "error", message);
    if (error instanceof CancellationError) {
      throw new HttpError(409, message);
    }
    throw error;
  } finally {
    await Promise.all(timingWrites);
  }
}

export function releaseForSchedule(eventDay: string, config: Config): Date {
  return releaseAt(eventDay, config);
}

function successfulResult(result: BookingTransactionResult): ExecutionResult {
  return {
    status: "succeeded",
    message: result.message,
    bookingOrderIds: result.bookingOrderIds,
    bookingTargets: result.bookingTargets,
    cancelledBookingIds: result.cancelledBookingIds,
    submitSkewMs: result.submitSkewMs,
  };
}
