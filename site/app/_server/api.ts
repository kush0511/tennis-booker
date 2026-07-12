import { getChatGPTUser, type ChatGPTUser } from "@/app/chatgpt-auth";
import { getRuntimeEnv } from "@/db";
import { DooremiClient, safeErrorMessage } from "@/lib/dooremi";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function requireApiUser(): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  if (process.env.NODE_ENV === "development") {
    const email = process.env.LOCAL_DEV_USER_EMAIL || "local@court-signal.test";
    return { email, displayName: "Local player", fullName: null };
  }
  throw new HttpError(401, "Sign in with ChatGPT to continue.");
}

export function dooremiClient(): DooremiClient {
  const token = getRuntimeEnv().DOOREMI_BEARER_TOKEN;
  if (!token) {
    throw new HttpError(
      503,
      "The hosted Dooremi token is not configured yet.",
    );
  }
  return new DooremiClient({ token });
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, "Send a valid JSON request.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "Send a JSON object.");
  }
  return payload as Record<string, unknown>;
}

export function requireSameOrigin(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError(403, "Cross-site write requests are not allowed.");
  }
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).origin !== new URL(request.url).origin) {
    throw new HttpError(403, "Cross-site write requests are not allowed.");
  }
}

export function data<T>(value: T, init?: ResponseInit): Response {
  return Response.json({ data: value }, init);
}

export function routeError(error: unknown): Response {
  const status = error instanceof HttpError ? error.status : 400;
  const message =
    error instanceof HttpError ? error.message : safeErrorMessage(error);
  return Response.json(
    { error: message || "The request could not be completed." },
    { status },
  );
}

export function positiveInteger(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}
