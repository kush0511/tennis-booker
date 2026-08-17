import contract from "../../shared/booking-contract.json" with { type: "json" };

export type BookingApiGuardState = {
  status: "unknown" | "healthy" | "disabled";
  bookingsEnabled: boolean;
  expectedAppVersion: string;
  observedAppVersion: string | null;
  checkedAt: string | null;
  lastHealthyAt: string | null;
  disabledAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  updatedAt: string;
};

export const DOOREMI_APP_STORE_ID = contract.api.appStoreId;
export const VERIFIED_DOOREMI_APP_VERSION = contract.api.verifiedAppVersion;
export const BOOKING_API_GUARD_MAX_AGE_MILLISECONDS = 8 * 60 * 60 * 1_000;
export const BOOKING_API_GUARD_CHECK_LEASE_MILLISECONDS = 60_000;

export type BookingGuardDecision = {
  enabled: boolean;
  reason: "healthy" | "missing" | "disabled" | "stale";
  message: string;
};

export function bookingGuardDecision(
  guard: BookingApiGuardState | null,
  now = Date.now(),
): BookingGuardDecision {
  if (!guard) {
    return {
      enabled: false,
      reason: "missing",
      message:
        "Booking API safety has not completed its first compatibility check. No booking or cancellation is allowed.",
    };
  }
  if (!guard.bookingsEnabled || guard.status !== "healthy") {
    return {
      enabled: false,
      reason: "disabled",
      message:
        guard.failureMessage ||
        "Booking APIs are safety-locked. Get a current HAR, update the verified contract, then validate and enable bookings.",
    };
  }
  const checkedAt = guard.checkedAt ? Date.parse(guard.checkedAt) : Number.NaN;
  if (
    !Number.isFinite(checkedAt) ||
    now - checkedAt > BOOKING_API_GUARD_MAX_AGE_MILLISECONDS
  ) {
    return {
      enabled: false,
      reason: "stale",
      message:
        "The booking API compatibility check is stale. No booking or cancellation is allowed until a fresh check succeeds.",
    };
  }
  return {
    enabled: true,
    reason: "healthy",
    message: "Booking APIs are verified and writes are enabled.",
  };
}

export function appStoreLookupUrl(): string {
  return `https://itunes.apple.com/lookup?id=${DOOREMI_APP_STORE_ID}&country=sg`;
}

export function parseDooremiAppVersion(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Apple returned an invalid app-version response.");
  }
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new Error("Apple did not return an app-version result.");
  }
  const app = results.find(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      Number((item as { trackId?: unknown }).trackId) === DOOREMI_APP_STORE_ID,
  ) as { version?: unknown } | undefined;
  if (!app || typeof app.version !== "string" || !app.version.trim()) {
    throw new Error("Apple did not identify the current Dooremi app version.");
  }
  return app.version.trim();
}
