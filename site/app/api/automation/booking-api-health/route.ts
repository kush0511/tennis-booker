import {
  data,
  HttpError,
  routeError,
} from "@/app/_server/api";
import { runBookingApiCompatibilityCheck } from "@/app/_server/booking-api-guard";
import { getRuntimeEnv } from "@/db";
import { getBookingApiGuard } from "@/db/repository";
import {
  bookingGuardDecision,
  canAutomationRecoverBookingGuard,
} from "@/lib/booking-guard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const expected = getRuntimeEnv().AUTOMATION_SECRET;
    const supplied = request.headers.get("authorization");
    if (!expected) throw new HttpError(503, "Hosted automation is not configured.");
    if (supplied !== `Bearer ${expected}`) {
      throw new HttpError(401, "Automation authorization failed.");
    }

    const previous = await getBookingApiGuard();
    const guard = await runBookingApiCompatibilityCheck({
      // Temporary Apple/provider transport, authentication, or availability
      // failures are not contract drift. They may recover only after this
      // complete provider login/history/availability/preview check succeeds.
      // Version drift and unfamiliar create/contract rejections stay latched
      // until the owner validates an updated HAR-backed contract.
      reenableOnSuccess: canAutomationRecoverBookingGuard(previous),
    });
    const decision = bookingGuardDecision(guard);
    if (!decision.enabled) {
      console.error(
        "Court Signal booking API guard disabled",
        JSON.stringify({
          failureCode: guard.failureCode,
          expectedAppVersion: guard.expectedAppVersion,
          observedAppVersion: guard.observedAppVersion,
          checkedAt: guard.checkedAt,
        }),
      );
    }
    return data(
      {
        healthy: decision.enabled,
        status: guard.status,
        bookingsEnabled: guard.bookingsEnabled,
        expectedAppVersion: guard.expectedAppVersion,
        observedAppVersion: guard.observedAppVersion,
        checkedAt: guard.checkedAt,
        lastHealthyAt: guard.lastHealthyAt,
        failureCode: guard.failureCode,
        message: decision.message,
      },
      decision.enabled ? undefined : { status: 503 },
    );
  } catch (error) {
    return routeError(error);
  }
}
