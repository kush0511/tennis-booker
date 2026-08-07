import {
  data,
  HttpError,
  maintainDooremiSession,
  routeError,
} from "@/app/_server/api";
import { getRuntimeEnv } from "@/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const expected = getRuntimeEnv().AUTOMATION_SECRET;
    const supplied = request.headers.get("authorization");
    if (!expected) throw new HttpError(503, "Hosted automation is not configured.");
    if (supplied !== `Bearer ${expected}`) {
      throw new HttpError(401, "Automation authorization failed.");
    }

    const status = await maintainDooremiSession();
    const healthy = status.autoRenewConfigured && !status.needsAttention;
    return data(
      {
        checkedAt: new Date().toISOString(),
        healthy,
        source: status.source,
        refreshedAt: status.refreshedAt,
        lastValidatedAt: status.lastValidatedAt,
        lastRefreshAttemptAt: status.lastRefreshAttemptAt,
        consecutiveFailures: status.consecutiveFailures,
        lastErrorCode: status.lastErrorCode,
      },
      healthy ? undefined : { status: 503 },
    );
  } catch (error) {
    return routeError(error);
  }
}
