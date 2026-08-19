import { loadAvailabilityWindow } from "@/app/_server/availability-window";
import {
  data,
  dooremiClient,
  HttpError,
  requireApiUser,
  routeError,
} from "@/app/_server/api";
import { getSettings } from "@/db/repository";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const user = await requireApiUser();
    const settings = await getSettings(user.email);
    if (!settings.facilityId || !settings.facilityCategoryId) {
      throw new HttpError(409, "Add your facility and category IDs first.");
    }
    const window = await loadAvailabilityWindow(
      await dooremiClient(),
      settings,
    );
    return data(window, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}
