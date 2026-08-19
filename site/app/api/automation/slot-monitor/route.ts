import { scanSlotMonitors } from "@/app/_server/slot-monitor";
import {
  data,
  HttpError,
  readJsonObject,
  routeError,
} from "@/app/_server/api";
import { getRuntimeEnv } from "@/db";
import {
  acknowledgeSlotNotifications,
  claimSlotNotifications,
} from "@/db/repository";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const expected = getRuntimeEnv().SLOT_MONITOR_SECRET;
    const supplied = request.headers.get("authorization");
    if (!expected) {
      throw new HttpError(503, "Slot email monitoring is not configured.");
    }
    if (supplied !== `Bearer ${expected}`) {
      throw new HttpError(401, "Slot monitor authorization failed.");
    }
    const body = await readJsonObject(request);
    if (body.action === "acknowledge") {
      const notificationIds = Array.isArray(body.notificationIds)
        ? body.notificationIds.filter(
            (value): value is string =>
              typeof value === "string" && value.length >= 8 && value.length <= 64,
          )
        : [];
      if (!notificationIds.length || notificationIds.length > 20) {
        throw new HttpError(400, "A valid notification acknowledgement is required.");
      }
      return data({
        acknowledged: await acknowledgeSlotNotifications(notificationIds),
      });
    }
    if (body.action !== "poll") {
      throw new HttpError(400, "Use the poll or acknowledge monitor action.");
    }
    const run = await scanSlotMonitors(new URL(request.url).origin);
    const notifications = await claimSlotNotifications();
    return data({ run, notifications });
  } catch (error) {
    return routeError(error);
  }
}
