import { createSchedule, getSettings, listSchedules } from "@/db/repository";
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
  releaseForSchedule,
} from "@/app/_server/execution";

export async function GET() {
  try {
    const user = await requireApiUser();
    return data(await listSchedules(user.email));
  } catch (error) {
    return routeError(error);
  }
}

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
    const targets = normalizeBookingTargets(schedule);
    if (targets.length > settings.maximumSessions) {
      throw new HttpError(
        400,
        `Choose at most ${settings.maximumSessions} sessions.`,
      );
    }
    const release = releaseForSchedule(eventDay, domainConfig(settings));
    if (release.valueOf() <= Date.now()) {
      throw new HttpError(409, "That booking window is already open. Book it now instead.");
    }
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    return data(
      await createSchedule({
        id,
        userEmail: user.email,
        eventDay: targets[0].eventDay,
        eventTimes: targets.map((target) => target.eventTime),
        facilityId: settings.facilityId,
        facilityCategoryId: settings.facilityCategoryId,
        releaseAt: release.toISOString(),
        status: "pending",
      }),
      { status: 201 },
    );
  } catch (error) {
    return routeError(error);
  }
}
