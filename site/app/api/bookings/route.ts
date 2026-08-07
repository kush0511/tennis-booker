import { data, dooremiClient, requireApiUser, routeError } from "@/app/_server/api";

export async function GET() {
  try {
    await requireApiUser();
    const client = await dooremiClient();
    const bookings = await client.bookingHistory({ pageSize: 50 });
    return data(bookings, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}
