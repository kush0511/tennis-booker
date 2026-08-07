import { getSettings } from "@/db/repository";
import { normalizeBookingTargets } from "@/lib/domain";
import { DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS } from "@/lib/dooremi-session";
import {
  data,
  dooremiClient,
  HttpError,
  requireApiUser,
  requireSameOrigin,
  routeError,
} from "@/app/_server/api";
import { domainSchedule } from "@/app/_server/execution";

export const dynamic = "force-dynamic";

/** Read-only owner diagnostic for the provider's current booking contract. */
export async function GET(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireApiUser();
    const settings = await getSettings(user.email);
    if (!settings.facilityId || !settings.facilityCategoryId) {
      throw new HttpError(409, "Add your facility and category IDs first.");
    }
    const url = new URL(request.url);
    const eventDay = url.searchParams.get("date") ?? "";
    const eventTime = url.searchParams.get("time") ?? "";
    const schedule = domainSchedule(eventDay, [eventTime], settings);
    normalizeBookingTargets(schedule);

    const client = await dooremiClient({
      freshWithinMilliseconds: DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS,
      requireManagedRefresh: true,
    });
    const preview = await client.prepareSingleBooking(schedule);
    return data({
      checkedAt: new Date().toISOString(),
      eventDay: preview.eventDay,
      eventTime: preview.eventTime,
      facilityName: preview.facilityName,
      bookingFeeAmount: preview.bookingFeeAmount,
      bookingFeeRequired: preview.bookingFeeRequired,
      hasPayNow: preview.hasPayNow,
      automaticPaymentRoute: preview.managementPaymentSelected
        ? "management"
        : "not-required",
      previewElapsedMs: preview.elapsedMs,
      providerDate: preview.serverDate?.toISOString() ?? null,
      mutatesBookingState: false,
    });
  } catch (error) {
    return routeError(error);
  }
}
