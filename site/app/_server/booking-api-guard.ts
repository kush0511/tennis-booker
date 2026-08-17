import { getRuntimeEnv } from "@/db";
import contract from "../../../shared/booking-contract.json" with { type: "json" };
import {
  claimBookingApiGuardCheck,
  getBookingApiGuard,
  recordBookingApiGuardFailure,
  recordBookingApiGuardHealthy,
  type BookingApiGuard,
} from "@/db/repository";
import {
  appStoreLookupUrl,
  BOOKING_API_GUARD_CHECK_LEASE_MILLISECONDS,
  parseDooremiAppVersion,
  VERIFIED_DOOREMI_APP_VERSION,
} from "@/lib/booking-guard";
import { suggestedSessionDay } from "@/lib/domain";
import { DooremiError, safeErrorMessage } from "@/lib/dooremi";
import { DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS } from "@/lib/dooremi-session";
import { dooremiClient } from "./api";

class CompatibilityCheckError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CompatibilityCheckError";
    this.code = code;
  }
}

function failureCode(error: unknown): string {
  if (error instanceof CompatibilityCheckError) return error.code;
  if (error instanceof DooremiError) return error.code;
  return "compatibility_check_failed";
}

export async function runBookingApiCompatibilityCheck(options: {
  reenableOnSuccess?: boolean;
  fetch?: typeof globalThis.fetch;
  now?: Date;
} = {}): Promise<BookingApiGuard> {
  const checkedAt = (options.now ?? new Date()).toISOString();
  const leaseUntil = new Date(
    Date.parse(checkedAt) + BOOKING_API_GUARD_CHECK_LEASE_MILLISECONDS,
  ).toISOString();
  const claimed = await claimBookingApiGuardCheck(
    checkedAt,
    leaseUntil,
    VERIFIED_DOOREMI_APP_VERSION,
  );
  if (!claimed) {
    const current = await getBookingApiGuard();
    if (current) return current;
    throw new Error("A booking API compatibility check is already running.");
  }

  let observedAppVersion: string | null = null;
  try {
    const appStoreResponse = await (options.fetch ?? globalThis.fetch)(
      appStoreLookupUrl(),
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!appStoreResponse.ok) {
      throw new CompatibilityCheckError(
        "app_version_lookup_failed",
        `Apple app-version lookup returned HTTP ${appStoreResponse.status}.`,
      );
    }
    observedAppVersion = parseDooremiAppVersion(
      await appStoreResponse.json(),
    );
    if (observedAppVersion !== VERIFIED_DOOREMI_APP_VERSION) {
      throw new CompatibilityCheckError(
        "app_version_changed",
        `Dooremi ${observedAppVersion} is newer than the verified ${VERIFIED_DOOREMI_APP_VERSION} contract. Bookings and provider cancellations are frozen until a current HAR is reviewed.`,
      );
    }

    const runtime = getRuntimeEnv();
    const facilityId = Number(runtime.DOOREMI_FACILITY_ID || 0);
    const facilityCategoryId = Number(runtime.DOOREMI_CATEGORY_ID || 0);
    if (!Number.isSafeInteger(facilityId) || facilityId <= 0) {
      throw new CompatibilityCheckError(
        "facility_not_configured",
        "The tennis facility ID is unavailable for the booking API check.",
      );
    }
    if (!Number.isSafeInteger(facilityCategoryId) || facilityCategoryId <= 0) {
      throw new CompatibilityCheckError(
        "category_not_configured",
        "The tennis category ID is unavailable for the booking API check.",
      );
    }

    const client = await dooremiClient({
      freshWithinMilliseconds: DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS,
      requireManagedRefresh: true,
    });
    client.assertBookingCredentialCurrent();
    await client.warmup();
    await client.bookingHistory({ pageSize: 1 });

    let previewed = false;
    for (let offset = -1; offset >= -7 && !previewed; offset -= 1) {
      const eventDay = suggestedSessionDay(
        contract.defaults.bookingLeadDays,
        offset,
        Date.parse(checkedAt),
      );
      const availability = await client.availability(
        eventDay,
        facilityId,
        facilityCategoryId,
      );
      const slot = availability.slots.find((item) => item.available);
      if (!slot) continue;
      await client.prepareSingleBooking({
        eventDay,
        eventTimes: [slot.eventTime],
        facilityId,
        facilityCategoryId,
      });
      previewed = true;
    }
    if (!previewed) {
      throw new CompatibilityCheckError(
        "preview_inconclusive",
        "Availability worked, but no open tennis slot was available for a read-only booking preview. Writes remain frozen until the contract can be verified.",
      );
    }

    return recordBookingApiGuardHealthy({
      checkedAt,
      expectedAppVersion: VERIFIED_DOOREMI_APP_VERSION,
      observedAppVersion,
      reenable: options.reenableOnSuccess === true,
    });
  } catch (error) {
    return recordBookingApiGuardFailure({
      checkedAt,
      expectedAppVersion: VERIFIED_DOOREMI_APP_VERSION,
      observedAppVersion,
      code: failureCode(error),
      message:
        safeErrorMessage(error) ||
        "The booking API compatibility check failed. No booking or cancellation is allowed.",
    });
  }
}
