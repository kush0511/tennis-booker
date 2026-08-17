import { claimSchedule, getSchedule, getSettings } from "@/db/repository";
import {
  data,
  HttpError,
  requireApiUser,
  requireBookingMutationsEnabled,
  requireSameOrigin,
  routeError,
} from "@/app/_server/api";
import { domainConfig, executeStoredSchedule } from "@/app/_server/execution";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireSameOrigin(request);
    const user = await requireApiUser();
    await requireBookingMutationsEnabled();
    const id = (await context.params).id;
    const owned = await getSchedule(id, user.email);
    if (!owned) throw new HttpError(404, "That schedule was not found.");
    if (new Date(owned.releaseAt).valueOf() - Date.now() > 240_000) {
      throw new HttpError(409, "That schedule is not inside its arming window yet.");
    }
    const claimed = await claimSchedule(id, 420);
    if (!claimed) throw new HttpError(409, "That schedule is already running or complete.");
    const settings = await getSettings(user.email);
    return data(await executeStoredSchedule(claimed, domainConfig(settings)));
  } catch (error) {
    return routeError(error);
  }
}
