import {
  data,
  requireApiUser,
  requireSameOrigin,
  routeError,
} from "@/app/_server/api";
import { runBookingApiCompatibilityCheck } from "@/app/_server/booking-api-guard";
import { bookingGuardDecision } from "@/lib/booking-guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireApiUser();
    const guard = await runBookingApiCompatibilityCheck({
      reenableOnSuccess: true,
    });
    const decision = bookingGuardDecision(guard);
    return data(
      {
        ...guard,
        message: decision.message,
      },
      decision.enabled ? undefined : { status: 503 },
    );
  } catch (error) {
    return routeError(error);
  }
}
