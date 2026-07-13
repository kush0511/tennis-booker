import { getSettings } from "@/db/repository";
import { normalizeEventDay } from "@/lib/domain";
import {
  data,
  dooremiClient,
  HttpError,
  requireApiUser,
  routeError,
} from "@/app/_server/api";

export async function GET(request: Request) {
  try {
    const user = await requireApiUser();
    const settings = await getSettings(user.email);
    if (!settings.facilityId || !settings.facilityCategoryId) {
      throw new HttpError(409, "Add your facility and category IDs first.");
    }
    const eventDay = normalizeEventDay(new URL(request.url).searchParams.get("date") || "");
    const availability = await dooremiClient().availability(
      eventDay,
      settings.facilityId,
      settings.facilityCategoryId,
    );
    return data(availability, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}
