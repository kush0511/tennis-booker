import {
  data,
  HttpError,
  positiveInteger,
  readJsonObject,
  requireApiUser,
  requireSameOrigin,
  routeError,
} from "@/app/_server/api";
import { getRuntimeEnv } from "@/db";
import {
  getOrCreateSlotMonitor,
  saveSlotMonitor,
} from "@/db/repository";

export const dynamic = "force-dynamic";

function deliveryStatus() {
  const runtime = getRuntimeEnv();
  return {
    deliveryConfigured: Boolean(
      runtime.SLOT_MONITOR_SECRET && runtime.GOOGLE_NOTIFICATION_EMAIL,
    ),
    recipientEmail: runtime.GOOGLE_NOTIFICATION_EMAIL || null,
  };
}

export async function GET() {
  try {
    const user = await requireApiUser();
    const delivery = deliveryStatus();
    const monitor = await getOrCreateSlotMonitor(
      user.email,
      delivery.recipientEmail || user.email,
    );
    return data({ monitor, ...delivery }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireApiUser();
    const value = await readJsonObject(request);
    if (typeof value.enabled !== "boolean") {
      throw new HttpError(400, "Choose whether email monitoring is enabled.");
    }
    const startMinute = positiveInteger(value.startMinute, "Start time", {
      min: 0,
      max: 1439,
    });
    const endMinute = positiveInteger(value.endMinute, "End time", {
      min: 1,
      max: 1440,
    });
    if (startMinute >= endMinute) {
      throw new HttpError(400, "The alert end time must be after its start time.");
    }
    const minimumContiguousSlots = positiveInteger(
      value.minimumContiguousSlots,
      "Contiguous sessions",
      { min: 1, max: 10 },
    );
    const delivery = deliveryStatus();
    const current = await getOrCreateSlotMonitor(
      user.email,
      delivery.recipientEmail || user.email,
    );
    const monitor = await saveSlotMonitor(user.email, {
      enabled: value.enabled,
      recipientEmail: delivery.recipientEmail || current.recipientEmail,
      startMinute,
      endMinute,
      minimumContiguousSlots,
    });
    return data({ monitor, ...delivery });
  } catch (error) {
    return routeError(error);
  }
}
