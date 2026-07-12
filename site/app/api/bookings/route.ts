import { data, dooremiClient, requireApiUser, routeError } from "@/app/_server/api";

export async function GET() {
  try {
    await requireApiUser();
    const bookings = await dooremiClient().bookingHistory({ pageSize: 50 });
    return data(bookings, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}
