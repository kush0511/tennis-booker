import { data, requireApiUser, routeError } from "@/app/_server/api";
import { getRuntimeEnv } from "@/db";
import { getAutomationHeartbeat, getSettings } from "@/db/repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireApiUser();
    const runtime = getRuntimeEnv();
    const [settings, heartbeat] = await Promise.all([
      getSettings(user.email),
      getAutomationHeartbeat(),
    ]);
    return data({
      checkedAt: new Date().toISOString(),
      dooremiConfigured: Boolean(runtime.DOOREMI_BEARER_TOKEN),
      automationEnabled:
        Boolean(runtime.AUTOMATION_SECRET) &&
        runtime.AUTOMATION_TRIGGER_ENABLED === "true",
      wakeWindow: "Every minute, 11:30 AM–12:05 PM SGT",
      lastSeenAt: heartbeat?.lastSeenAt ?? null,
      scheduledAt: heartbeat?.scheduledAt ?? null,
      releaseTiming: {
        leadDays: settings.bookingLeadDays,
        hour: settings.releaseHour,
        minute: settings.releaseMinute,
        preparationSeconds: settings.cancellationLeadSeconds,
        fireDelayMilliseconds: settings.fireDelayMilliseconds,
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
