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

const PROVIDER_BOOKING_LIMIT_PATTERN =
  /you have reached the booking limit according to house rules/i;
const TRANSIENT_BACKGROUND_LOGIN_PATTERN =
  /dooremi is temporarily unavailable during background sign-in/i;
const RECOVERABLE_GUARD_FAILURE_CODES = new Set([
  "api",
  "authentication",
  "connectivity",
  "timeout",
  "rate_limit",
  "app_version_lookup_failed",
  "preview_inconclusive",
]);

const KNOWN_GUARD_FAILURE_CODES = new Set([
  ...RECOVERABLE_GUARD_FAILURE_CODES,
  "app_version_changed",
  "client_upgrade_required",
  "rejected",
  "ambiguous_submission",
  "facility_not_configured",
  "category_not_configured",
  "compatibility_check_failed",
]);

export function compatibilityFailureCode(error: unknown): string {
  if (!error || typeof error !== "object") return "compatibility_check_failed";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && KNOWN_GUARD_FAILURE_CODES.has(code)
    ? code
    : "compatibility_check_failed";
}

export function isCompatiblePreviewBusinessRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "rejected" &&
    typeof candidate.message === "string" &&
    PROVIDER_BOOKING_LIMIT_PATTERN.test(candidate.message)
  );
}

export function canAutomationRecoverBookingGuard(
  guard: Pick<BookingApiGuardState, "failureCode" | "failureMessage"> | null,
): boolean {
  return (
    (typeof guard?.failureCode === "string" &&
      RECOVERABLE_GUARD_FAILURE_CODES.has(guard.failureCode)) ||
    (guard?.failureCode === "compatibility_check_failed" &&
      typeof guard.failureMessage === "string" &&
      TRANSIENT_BACKGROUND_LOGIN_PATTERN.test(guard.failureMessage)) ||
    isCompatiblePreviewBusinessRejection({
      code: guard?.failureCode,
      message: guard?.failureMessage,
    })
  );
}

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

export function appStorePageUrl(): string {
  return `https://apps.apple.com/sg/app/dooremi/id${DOOREMI_APP_STORE_ID}`;
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

export function parseDooremiAppVersionFromPage(html: string): string {
  const match = /\bVersion\s+(\d+(?:\.\d+){1,3})\b/i.exec(html);
  if (!match) {
    throw new Error("Apple's App Store page did not identify the current version.");
  }
  return match[1];
}
