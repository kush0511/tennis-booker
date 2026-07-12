import {
  data,
  dooremiClient,
  HttpError,
  positiveInteger,
  requireApiUser,
  requireSameOrigin,
  routeError,
} from "@/app/_server/api";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireSameOrigin(request);
    await requireApiUser();
    const id = positiveInteger((await context.params).id, "Booking ID");
    const client = dooremiClient();
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
