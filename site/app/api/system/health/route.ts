import {
  data,
  bookingMutationStatus,
  maintainDooremiSession,
  requireApiUser,
  routeError,
} from "@/app/_server/api";
import { getRuntimeEnv } from "@/db";
import { getAutomationHeartbeat, getSettings } from "@/db/repository";
import {
  effectiveHostedPreparationLead,
  externalWakeCoversRelease,
  HOSTED_AMBIGUOUS_RECONCILIATION_DELAYS_MILLISECONDS,
  HOSTED_FALLBACK_ROUND_TRIP_MILLISECONDS,
  HOSTED_LATENCY_PERCENTILE,
  HOSTED_LATENCY_PROBE_COUNT,
  HOSTED_MAXIMUM_EARLY_SUBMISSION_MILLISECONDS,
  HOSTED_MAX_TRANSMISSION_LEAD_MILLISECONDS,
  HOSTED_MINIMUM_LATENCY_SAMPLES,
  HOSTED_PRE_CANCELLATION_MINIMUM_SUCCESSES,
  HOSTED_PRE_CANCELLATION_PROBE_COUNT,
  HOSTED_REJECTED_SUBMISSION_RETRY_DELAYS_MILLISECONDS,
  HOSTED_REJECTED_SUBMISSION_RETRIES,
} from "@/lib/automation";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireApiUser();
    const runtime = getRuntimeEnv();
    const [settings, heartbeat, session, bookingGuard] = await Promise.all([
      getSettings(user.email),
      getAutomationHeartbeat(),
      maintainDooremiSession(),
      bookingMutationStatus(),
    ]);
    const checkedAt = new Date();
    const heartbeatAgeSeconds = heartbeat
      ? Math.max(0, Math.round((checkedAt.valueOf() - Date.parse(heartbeat.lastSeenAt)) / 1000))
      : null;
    return data({
      checkedAt: checkedAt.toISOString(),
      dooremiConfigured:
        session.autoRenewConfigured ||
        session.source === "managed" ||
        session.source === "bootstrap",
      bookingCredential: session.bookingCredential,
      managedSession: {
        autoRenewConfigured: session.autoRenewConfigured,
        source: session.source,
        refreshedAt: session.refreshedAt,
        lastValidatedAt: session.lastValidatedAt,
        lastRefreshAttemptAt: session.lastRefreshAttemptAt,
        consecutiveFailures: session.consecutiveFailures,
        lastErrorCode: session.lastErrorCode,
        lastErrorMessage: session.lastErrorMessage,
        loginIdentifierKind: session.loginIdentifierKind,
        needsAttention: session.needsAttention,
      },
      bookingApiGuard: {
        status: bookingGuard.guard.status,
        bookingsEnabled: bookingGuard.decision.enabled,
        expectedAppVersion: bookingGuard.guard.expectedAppVersion,
        observedAppVersion: bookingGuard.guard.observedAppVersion,
        checkedAt: bookingGuard.guard.checkedAt,
        lastHealthyAt: bookingGuard.guard.lastHealthyAt,
        disabledAt: bookingGuard.guard.disabledAt,
        failureCode: bookingGuard.guard.failureCode,
        failureMessage: bookingGuard.guard.failureMessage,
        message: bookingGuard.decision.message,
      },
      automationEnabled:
        Boolean(runtime.AUTOMATION_SECRET) &&
        runtime.AUTOMATION_TRIGGER_ENABLED === "true" &&
        externalWakeCoversRelease(settings.releaseHour, settings.releaseMinute),
      wakeWindow: "Every minute, all day, Asia/Singapore",
      lastSeenAt: heartbeat?.lastSeenAt ?? null,
      scheduledAt: heartbeat?.scheduledAt ?? null,
      heartbeatAgeSeconds,
      releaseTiming: {
        leadDays: settings.bookingLeadDays,
        hour: settings.releaseHour,
        minute: settings.releaseMinute,
        preparationSeconds: effectiveHostedPreparationLead(
          settings.cancellationLeadSeconds,
        ),
        cancellationSeconds: settings.cancellationLeadSeconds,
        fireDelayMilliseconds: settings.fireDelayMilliseconds,
        maximumTransmissionLeadMilliseconds:
          HOSTED_MAX_TRANSMISSION_LEAD_MILLISECONDS,
        maximumEarlySubmissionMilliseconds:
          HOSTED_MAXIMUM_EARLY_SUBMISSION_MILLISECONDS,
        preCancellationProbeCount:
          HOSTED_PRE_CANCELLATION_PROBE_COUNT,
        preCancellationMinimumSuccesses:
          HOSTED_PRE_CANCELLATION_MINIMUM_SUCCESSES,
        latencyProbeCount: HOSTED_LATENCY_PROBE_COUNT,
        latencyPercentile: HOSTED_LATENCY_PERCENTILE,
        minimumLatencySamples: HOSTED_MINIMUM_LATENCY_SAMPLES,
        fallbackRoundTripMilliseconds:
          HOSTED_FALLBACK_ROUND_TRIP_MILLISECONDS,
        rejectedSubmissionRetries: HOSTED_REJECTED_SUBMISSION_RETRIES,
        rejectedSubmissionRetryDelaysMilliseconds:
          HOSTED_REJECTED_SUBMISSION_RETRY_DELAYS_MILLISECONDS,
        ambiguousReconciliationDelaysMilliseconds:
          HOSTED_AMBIGUOUS_RECONCILIATION_DELAYS_MILLISECONDS,
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
