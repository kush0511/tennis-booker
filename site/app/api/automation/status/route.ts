import { data, HttpError, routeError } from "@/app/_server/api";
import { getRuntimeEnv } from "@/db";
import {
  AUTOMATION_CRON,
  AUTOMATION_HEARTBEAT_ID,
} from "@/lib/automation";

export const dynamic = "force-dynamic";

type HeartbeatRow = {
  last_seen_at: string;
  scheduled_at: string;
  cron: string;
};

export async function GET(request: Request) {
  try {
    const runtime = getRuntimeEnv();
    const expected = runtime.AUTOMATION_SECRET;
    const supplied = request.headers.get("authorization");
    if (!expected) {
      throw new HttpError(503, "Hosted automation is not configured.");
    }
    if (supplied !== `Bearer ${expected}`) {
      throw new HttpError(401, "Automation authorization failed.");
    }

    await runtime.DB.prepare(`CREATE TABLE IF NOT EXISTS automation_heartbeat (
      id TEXT PRIMARY KEY,
      last_seen_at TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      cron TEXT NOT NULL
    )`).run();
    const heartbeat = await runtime.DB
      .prepare(`SELECT last_seen_at, scheduled_at, cron
        FROM automation_heartbeat WHERE id = ?`)
      .bind(AUTOMATION_HEARTBEAT_ID)
      .first<HeartbeatRow>();

    return data({
      enabled: runtime.AUTOMATION_TRIGGER_ENABLED === "true",
      expectedCron: AUTOMATION_CRON,
      lastSeenAt: heartbeat?.last_seen_at ?? null,
      scheduledAt: heartbeat?.scheduled_at ?? null,
      observedCron: heartbeat?.cron ?? null,
    });
  } catch (error) {
    return routeError(error);
  }
}
