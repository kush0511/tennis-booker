import {
  data,
  dooremiClient,
  requireApiUser,
  requireSameOrigin,
  routeError,
} from "@/app/_server/api";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireApiUser();
    const client = await dooremiClient();
    client.assertBookingCredentialCurrent();
    const result = await client.warmup();
    return data({
      checkedAt: new Date().toISOString(),
      elapsedMs: result.elapsedMs,
      serverDate: result.serverDate?.toISOString() ?? null,
    });
  } catch (error) {
    return routeError(error);
  }
}
