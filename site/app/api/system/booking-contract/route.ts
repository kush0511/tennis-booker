import { getRuntimeEnv } from "@/db";
import { normalizeBookingTargets } from "@/lib/domain";
import { DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS } from "@/lib/dooremi-session";
import {
  data,
  dooremiClient,
  HttpError,
  requireSameOrigin,
  routeError,
} from "@/app/_server/api";
import { domainSchedule } from "@/app/_server/execution";

export const dynamic = "force-dynamic";

/** Read-only owner diagnostic for the provider's current booking contract. */
export async function GET(request: Request) {
  try {
    requireSameOrigin(request);
    const runtime = getRuntimeEnv();
    const facilityId = Number(runtime.DOOREMI_FACILITY_ID || 0);
    const facilityCategoryId = Number(runtime.DOOREMI_CATEGORY_ID || 0);
    if (!facilityId || !facilityCategoryId) {
      throw new HttpError(409, "Add your facility and category IDs first.");
    }
    const url = new URL(request.url);
    const eventDay = url.searchParams.get("date") ?? "";
    const eventTime = url.searchParams.get("time") ?? "";
    const schedule = domainSchedule(eventDay, [eventTime], {
      facilityId,
      facilityCategoryId,
    });
    normalizeBookingTargets(schedule);

    const client = await dooremiClient({
      freshWithinMilliseconds: DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS,
      requireManagedRefresh: true,
    });
    const availability = await client.availability(
      eventDay,
      facilityId,
      facilityCategoryId,
    );
    const slot = availability.slots.find(
      (candidate) => candidate.eventTime === eventTime,
    );
    const preview = await client.prepareSingleBooking(schedule);
    return data({
      checkedAt: new Date().toISOString(),
      configuredFacilityId: facilityId,
      availabilityFacilityId: availability.facilityId,
      slotFacilityId: slot?.facilityId ?? null,
      slotId: slot?.id ?? null,
      slotAvailable: slot?.available ?? null,
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
