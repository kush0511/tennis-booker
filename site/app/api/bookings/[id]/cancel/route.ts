import {
  data,
  dooremiClient,
  HttpError,
  positiveInteger,
  requireBookingMutationsEnabled,
  requireApiUser,
  requireSameOrigin,
  routeError,
} from "@/app/_server/api";
import { DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS } from "@/lib/dooremi-session";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireSameOrigin(request);
    await requireApiUser();
    await requireBookingMutationsEnabled();
    const id = positiveInteger((await context.params).id, "Booking ID");
    const client = await dooremiClient({
      freshWithinMilliseconds: DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS,
      requireManagedRefresh: true,
    });
    const bookings = await client.bookingHistory({ pageSize: 50 });
    const booking = bookings.find((item) => item.id === id);
    if (!booking) throw new HttpError(404, "That booking was not found.");
    if (!booking.canCancel) {
      throw new HttpError(409, "Dooremi does not allow that booking to be cancelled.");
    }
    return data(await client.cancelBooking(id));
  } catch (error) {
    return routeError(error);
  }
}
