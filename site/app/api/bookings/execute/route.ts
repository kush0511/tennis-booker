import { getSettings } from "@/db/repository";
import { normalizeBookingTargets } from "@/lib/domain";
import {
  data,
  HttpError,
  readJsonObject,
  requireApiUser,
  requireSameOrigin,
  routeError,
} from "@/app/_server/api";
import {
  domainConfig,
  domainSchedule,
  executeImmediate,
  releaseForSchedule,
} from "@/app/_server/execution";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireApiUser();
    const settings = await getSettings(user.email);
    if (!settings.facilityId || !settings.facilityCategoryId) {
      throw new HttpError(409, "Add your facility and category IDs first.");
    }
    const body = await readJsonObject(request);
    const eventDay = typeof body.eventDay === "string" ? body.eventDay : "";
    const eventTimes = Array.isArray(body.eventTimes)
      ? body.eventTimes.filter((value): value is string => typeof value === "string")
      : [];
    const schedule = domainSchedule(eventDay, eventTimes, settings);
    normalizeBookingTargets(schedule);
    const config = domainConfig(settings);
    if (releaseForSchedule(eventDay, config).valueOf() > Date.now()) {
      throw new HttpError(
        409,
        "That booking window has not opened. Arm a release plan instead.",
      );
    }
    return data(await executeImmediate(schedule, config));
  } catch (error) {
    return routeError(error);
  }
}
