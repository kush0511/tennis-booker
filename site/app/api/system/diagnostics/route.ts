import { data, HttpError, routeError } from "@/app/_server/api";
import { getRuntimeEnv } from "@/db";
import {
  listRecentScheduleFailures,
  listScheduleEventsForDiagnostics,
} from "@/db/repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const expected = getRuntimeEnv().DIAGNOSTIC_SECRET;
    const supplied = request.headers.get("authorization");
    if (!expected) {
      throw new HttpError(503, "Hosted diagnostics are disabled.");
    }
    if (supplied !== `Bearer ${expected}`) {
      throw new HttpError(401, "Diagnostics authorization failed.");
    }

    const failures = await listRecentScheduleFailures();
    const schedules = await Promise.all(
      failures.map(async (failure) => ({
        scheduleId: failure.id,
        status: failure.status,
        eventDay: failure.eventDay,
        eventTimes: failure.eventTimes,
        releaseAt: failure.releaseAt,
        claimedAt: failure.claimedAt,
        attemptedAt: failure.attemptedAt,
        resultMessage: failure.resultMessage,
        bookingOrderIds: failure.bookingOrderIds,
        preparedTargets: failure.preparedTargets,
        submittedTargets: failure.submittedTargets,
        cancelledBookingIds: failure.cancelledBookingIds,
        submitSkewMs: failure.submitSkewMs,
        createdAt: failure.createdAt,
        updatedAt: failure.updatedAt,
        events: await listScheduleEventsForDiagnostics(failure.id),
      })),
    );

    return data({ checkedAt: new Date().toISOString(), schedules });
  } catch (error) {
    return routeError(error);
  }
}
