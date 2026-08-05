import { appendScheduleEvent, finishSchedule, type StoredSchedule } from "@/db/repository";
import { releaseAt, type Config, type Schedule } from "@/lib/domain";
import { dooremiClient, HttpError } from "./api";
import {
  CancellationError,
  PartialBookingError,
  RebookingSubmissionError,
  executeBookingTransaction,
  type BookingTransactionResult,
} from "@/lib/transaction";
import { safeErrorMessage } from "@/lib/dooremi";
import {
  effectiveHostedPreparationLead,
  HOSTED_MAX_TRANSMISSION_LEAD_MILLISECONDS,
  HOSTED_REJECTED_SUBMISSION_RETRIES,
  HOSTED_REJECTED_SUBMISSION_RETRY_DELAY_MILLISECONDS,
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
  const result = await executeBookingTransaction(dooremiClient(), schedule, {
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
  const timing = (message: string) => {
    void appendScheduleEvent(stored.id, stored.userEmail, "info", message);
  };
  timing(
    `hosted preparation started at T-${preparationLeadSeconds}s; cancellation remains at T-${config.cancellationLeadSeconds}s`,
  );

  try {
    const result = await executeBookingTransaction(dooremiClient(), schedule, {
      maxSessions: config.maxSessionsPerBooking,
      warmupPasses: 2,
      cancelAt: new Date(
        release.valueOf() - config.cancellationLeadSeconds * 1_000,
      ),
      secondWarmupAt: new Date(release.valueOf() - 3_000),
      releaseAt: release,
      fireDelayMilliseconds: config.fireDelayMilliseconds,
      maximumTransmissionLeadMilliseconds:
        HOSTED_MAX_TRANSMISSION_LEAD_MILLISECONDS,
      rejectedSubmissionRetries: HOSTED_REJECTED_SUBMISSION_RETRIES,
      rejectedSubmissionRetryDelayMilliseconds:
        HOSTED_REJECTED_SUBMISSION_RETRY_DELAY_MILLISECONDS,
      rejectedSubmissionRetryStaggerMilliseconds:
        HOSTED_REJECTED_SUBMISSION_RETRY_STAGGER_MILLISECONDS,
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
      error instanceof RebookingSubmissionError ? error.bookingTargets : [];
    const submitSkewMs =
      error instanceof RebookingSubmissionError ? error.submitSkewMs : null;
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
