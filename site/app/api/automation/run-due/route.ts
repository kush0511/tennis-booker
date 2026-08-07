import { getRuntimeEnv } from "@/db";
import {
  claimSchedule,
  getSettings,
  listUnreportedScheduleFailures,
  listDueSchedules,
  markScheduleFailureReported,
  recordAutomationHeartbeat,
} from "@/db/repository";
import {
  data,
  HttpError,
  maintainDooremiSession,
  routeError,
} from "@/app/_server/api";
import { domainConfig, executeStoredSchedule } from "@/app/_server/execution";
import { HOSTED_ARMING_WINDOW_SECONDS } from "@/lib/automation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function exportUnreportedFailures(): Promise<void> {
  try {
    const failures = await listUnreportedScheduleFailures();
    for (const failure of failures) {
      console.error(
        "Court Signal schedule failure",
        JSON.stringify({
          scheduleId: failure.id,
          status: failure.status,
          eventDay: failure.eventDay,
          eventTimes: failure.eventTimes,
          releaseAt: failure.releaseAt,
          attemptedAt: failure.attemptedAt,
          resultMessage: failure.resultMessage,
          bookingOrderIds: failure.bookingOrderIds,
          cancelledBookingIds: failure.cancelledBookingIds,
          submitSkewMs: failure.submitSkewMs,
          updatedAt: failure.updatedAt,
        }),
      );
      await markScheduleFailureReported(failure.id);
    }
  } catch (error) {
    console.error(
      "Court Signal could not export schedule diagnostics",
      error instanceof Error ? error.message : "Unknown diagnostics error.",
    );
  }
}

export async function POST(request: Request) {
  try {
    const expected = getRuntimeEnv().AUTOMATION_SECRET;
    const supplied = request.headers.get("authorization");
    if (!expected) throw new HttpError(503, "Hosted automation is not configured.");
    if (supplied !== `Bearer ${expected}`) {
      throw new HttpError(401, "Automation authorization failed.");
    }

    const now = new Date().toISOString();
    const scheduledHeader = request.headers.get("x-cloudscheduler-scheduletime");
    const scheduledAt = scheduledHeader && !Number.isNaN(Date.parse(scheduledHeader))
      ? new Date(scheduledHeader).toISOString()
      : now;
    await recordAutomationHeartbeat({
      lastSeenAt: now,
      scheduledAt,
      cron: "Google Cloud Scheduler",
    });
    const credentialHealth = await maintainDooremiSession().catch((error) => {
      console.error(
        "Court Signal credential maintenance failed",
        error instanceof Error ? error.message : "Unknown credential error.",
      );
      return null;
    });
    await exportUnreportedFailures();
    const due = await listDueSchedules(now, HOSTED_ARMING_WINDOW_SECONDS);
    // Every plan for the same release boundary must arm independently. A
    // sequential loop lets the first user sleep until release while every later
    // user misses the synchronized submission window.
    const results = (
      await Promise.all(
        due.map(async (schedule) => {
          const claimed = await claimSchedule(schedule.id, 420);
          if (!claimed) return null;
          const settings = await getSettings(claimed.userEmail);
          try {
            return {
              id: claimed.id,
              ...(await executeStoredSchedule(claimed, domainConfig(settings))),
            };
          } catch (error) {
            return {
              id: claimed.id,
              status: "failed",
              message:
                error instanceof Error ? error.message : "Execution failed.",
            };
          }
        }),
      )
    ).filter((result) => result !== null);
    await exportUnreportedFailures();
    return data({
      checkedAt: now,
      credential: credentialHealth
        ? {
            source: credentialHealth.source,
            autoRenewConfigured: credentialHealth.autoRenewConfigured,
            refreshedAt: credentialHealth.refreshedAt,
            lastValidatedAt: credentialHealth.lastValidatedAt,
            consecutiveFailures: credentialHealth.consecutiveFailures,
            needsAttention: credentialHealth.needsAttention,
          }
        : { needsAttention: true },
      schedules: results,
    });
  } catch (error) {
    return routeError(error);
  }
}
