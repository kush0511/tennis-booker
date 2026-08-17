import { getSettings, saveSettings, type UserSettings } from "@/db/repository";
import {
  data,
  positiveInteger,
  readJsonObject,
  requireApiUser,
  requireSameOrigin,
  routeError,
} from "@/app/_server/api";

export async function GET() {
  try {
    const user = await requireApiUser();
    return data(await getSettings(user.email));
  } catch (error) {
    return routeError(error);
  }
}

export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireApiUser();
    const value = await readJsonObject(request);
    const settings: UserSettings = {
      facilityId: positiveInteger(value.facilityId, "Facility ID"),
      facilityCategoryId: positiveInteger(
        value.facilityCategoryId,
        "Category ID",
      ),
      bookingLeadDays: positiveInteger(value.bookingLeadDays, "Lead days", {
        min: 1,
        max: 60,
      }),
      releaseHour: positiveInteger(value.releaseHour, "Release hour", {
        min: 0,
        max: 23,
      }),
      releaseMinute: positiveInteger(value.releaseMinute, "Release minute", {
        min: 0,
        max: 59,
      }),
      cancellationLeadSeconds: positiveInteger(
        value.cancellationLeadSeconds,
        "Cancellation lead",
        { min: 5, max: 120 },
      ),
      fireDelayMilliseconds: positiveInteger(
        value.fireDelayMilliseconds,
        "Fire delay",
        { min: 0, max: 1000 },
      ),
      maximumSessions: positiveInteger(
        value.maximumSessions,
        "Maximum sessions",
        { min: 1, max: 10 },
      ),
    };
    return data(await saveSettings(user.email, settings));
  } catch (error) {
    return routeError(error);
  }
}
