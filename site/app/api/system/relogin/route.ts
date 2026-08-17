import {
  data,
  reloginDooremiSession,
  requireApiUser,
  requireSameOrigin,
  routeError,
} from "@/app/_server/api";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireApiUser();
    const result = await reloginDooremiSession();
    return data({
      refreshedAt: result.status.refreshedAt,
      elapsedMs: result.elapsedMs,
      serverDate: result.serverDate,
      bookingCredential: result.status.bookingCredential,
    });
  } catch (error) {
    return routeError(error);
  }
}
