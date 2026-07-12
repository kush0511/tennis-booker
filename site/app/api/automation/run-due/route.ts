import { getRuntimeEnv } from "@/db";
import {
  claimSchedule,
  getSettings,
  listDueSchedules,
  recordAutomationHeartbeat,
} from "@/db/repository";
import { data, HttpError, routeError } from "@/app/_server/api";
import { domainConfig, executeStoredSchedule } from "@/app/_server/execution";

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
    const due = await listDueSchedules(now, 240);
    const results = [];
    for (const schedule of due) {
      const claimed = await claimSchedule(schedule.id, 420);
      if (!claimed) continue;
      const settings = await getSettings(claimed.userEmail);
      try {
        results.push({
          id: claimed.id,
          ...(await executeStoredSchedule(claimed, domainConfig(settings))),
        });
      } catch (error) {
        results.push({
          id: claimed.id,
          status: "failed",
          message: error instanceof Error ? error.message : "Execution failed.",
        });
      }
    }
    return data({ checkedAt: now, schedules: results });
  } catch (error) {
    return routeError(error);
  }
}
