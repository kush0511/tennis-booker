import { getRuntimeEnv } from "@/db";
import {
  claimSchedule,
  getSettings,
  listDueSchedules,
  recordAutomationHeartbeat,
} from "@/db/repository";
import { data, HttpError, routeError } from "@/app/_server/api";
import { domainConfig, executeStoredSchedule } from "@/app/_server/execution";
import { HOSTED_ARMING_WINDOW_SECONDS } from "@/lib/automation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
    return data({ checkedAt: now, schedules: results });
  } catch (error) {
    return routeError(error);
  }
}
