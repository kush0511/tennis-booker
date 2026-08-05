import {
  bookingPayload,
  normalizeBookingTargets,
  normalizeEventDay,
  normalizeFacilityId,
  parseAvailabilityPayload,
  singleTargetSchedule,
  type Availability,
  type BookingRecord,
  type Schedule,
} from "./domain.js";

export const DOOREMI_BASE_URL = "https://api.dooremi.com.sg";
export const DOOREMI_IOS_USER_AGENT =
  "LifeUp/1 CFNetwork/3860.600.12 Darwin/25.5.0";
export const DOOREMI_ENDPOINTS = Object.freeze({
  checkLogin: "/user/checkLogin",
  availability: "/user/booking/facilitySlot",
  preview: "/user/booking/orderPreview",
  createBooking: "/user/booking/createOrderV2",
  bookingHistory: "/user/booking/history",
  bookingDetail: "/user/booking/detail",
  cancelBooking: "/user/booking/cancel",
});

export type DooremiErrorCode =
  | "authentication"
  | "timeout"
  | "connectivity"
  | "rate_limit"
  | "rejected"
  | "api"
  | "ambiguous_submission";

export class DooremiError extends Error {
  readonly code: DooremiErrorCode;
  readonly httpStatus: number | null;

  constructor(
    message: string,
    code: DooremiErrorCode = "api",
    httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "DooremiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class AuthenticationError extends DooremiError {
  constructor() {
    super(
      "The Dooremi session has expired. Update the hosted Dooremi token.",
      "authentication",
    );
    this.name = "AuthenticationError";
  }
}

export class NetworkTimeoutError extends DooremiError {
  constructor() {
    super(
      "Dooremi timed out. The hosted token was not marked invalid.",
      "timeout",
    );
    this.name = "NetworkTimeoutError";
  }
}

export class ConnectivityError extends DooremiError {
  constructor() {
    super("The hosted runner could not reach Dooremi.", "connectivity");
    this.name = "ConnectivityError";
  }
}

export class RateLimitError extends DooremiError {
  constructor() {
    super(
      "Dooremi is rate-limiting requests. No automatic retry was made.",
      "rate_limit",
      429,
    );
    this.name = "RateLimitError";
  }
}

export class AmbiguousSubmissionError extends DooremiError {
  constructor(message = "Dooremi did not return a readable booking confirmation.") {
    super(
      `${message} Refresh booking history before attempting anything else; no automatic retry was made.`,
      "ambiguous_submission",
    );
    this.name = "AmbiguousSubmissionError";
  }
}

export function safeErrorMessage(error: unknown): string {
  const original = error instanceof Error ? error.message : "Unexpected error";
  return original
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[redacted token]",
    )
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 320);
}

export interface WarmupResult {
  elapsedMs: number;
  serverDate: Date | null;
}

export interface SingleBookingResult {
  message: string;
  bookingOrderId: number | null;
}

export interface CancelBookingResult {
  message: string;
  bookingId: number;
}

export interface BookingPreview {
  message: string;
  facilityName: string | null;
  eventDay: string;
  eventTimes: string[];
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface DooremiClientOptions {
  /** Raw credential value only. Obtain this from a server-side secret binding. */
  token: string;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
  monotonicNow?: () => number;
}

interface RequestOptions {
  query?: Record<string, string | number>;
  body?: unknown;
  ambiguousSubmission?: boolean;
}

interface RequestResult {
  payload: Record<string, unknown>;
  headers: Headers;
  elapsedMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numericId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const candidate = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(candidate) ? candidate : null;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isAuthenticationMessage(message: string): boolean {
  const lower = message.toLocaleLowerCase("en");
  return ["login", "token", "expired", "unauthorized"].some((word) =>
    lower.includes(word),
  );
}

function validateRawToken(token: string): void {
  if (!token || token.trim() !== token || /^Bearer\s/i.test(token)) {
    throw new DooremiError(
      "The hosted Dooremi token must contain only the raw credential value.",
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(token)) {
    throw new DooremiError("The hosted Dooremi token has an invalid format.");
  }
}

/**
 * Cloudflare-compatible Dooremi transport.
 *
 * The token is held in an ECMAScript private field, has no getter, and is never
 * included in results or errors. Instantiate this class only in server routes,
 * server actions, or Worker handlers using a Sites secret binding.
 */
export class DooremiClient {
  #token: string;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #monotonicNow: () => number;

  constructor(options: DooremiClientOptions) {
    validateRawToken(options.token);
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new DooremiError("The Dooremi timeout must be greater than zero.");
    }

    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#baseUrl = options.baseUrl ?? DOOREMI_BASE_URL;
    this.#timeoutMs = options.timeoutMs ?? 12_000;
    this.#userAgent = options.userAgent ?? DOOREMI_IOS_USER_AGENT;
    this.#monotonicNow =
      options.monotonicNow ?? (() => globalThis.performance.now());
  }

  /** Creates another stateless facade without exposing the credential. */
  fork(): DooremiClient {
    return new DooremiClient({
      token: this.#token,
      fetch: this.#fetch,
      baseUrl: this.#baseUrl,
      timeoutMs: this.#timeoutMs,
      userAgent: this.#userAgent,
      monotonicNow: this.#monotonicNow,
    });
  }

  async warmup(): Promise<WarmupResult> {
    const result = await this.#request(DOOREMI_ENDPOINTS.checkLogin);
    const header = result.headers.get("date");
    const parsed = header ? new Date(header) : null;
    return {
      elapsedMs: result.elapsedMs,
      serverDate: parsed && !Number.isNaN(parsed.valueOf()) ? parsed : null,
    };
  }

  async availability(
    eventDay: string,
    facilityId: number,
    facilityCategoryId: number,
  ): Promise<Availability> {
    const normalizedDay = normalizeEventDay(eventDay);
    const normalizedFacilityId = normalizeFacilityId(facilityId);
    const normalizedCategoryId = normalizeFacilityId(facilityCategoryId);
    const result = await this.#request(DOOREMI_ENDPOINTS.availability, {
      query: {
        facilityId: normalizedFacilityId,
        eventDate: normalizedDay,
        facilityCategoryId: normalizedCategoryId,
      },
    });
    return parseAvailabilityPayload(result.payload, normalizedFacilityId);
  }

  async preview(schedule: Schedule): Promise<BookingPreview> {
    const previews = await Promise.all(
      normalizeBookingTargets(schedule).map(async (target) => {
        const single = singleTargetSchedule(schedule, target);
        const result = await this.#request(DOOREMI_ENDPOINTS.preview, {
          body: bookingPayload(single),
        });
        const content = asRecord(result.payload.content) ?? {};
        const facility = asRecord(asArray(content.bookingOrderFacilityList)[0]) ?? {};
        return {
          message: text(result.payload.msg, "ok"),
          facilityName:
            typeof facility.facilityName === "string"
              ? facility.facilityName
              : typeof content.facilityName === "string"
                ? content.facilityName
                : null,
          eventDay: text(facility.eventDate, single.eventDay),
          eventTime: text(facility.eventTime, target.eventTime),
        };
      }),
    );
    return {
      message: previews[0]?.message ?? "ok",
      facilityName: previews[0]?.facilityName ?? null,
      eventDay: previews[0]?.eventDay ?? normalizeEventDay(schedule.eventDay),
      eventTimes: previews.map((item) => item.eventTime),
    };
  }

  async createSingleBooking(schedule: Schedule): Promise<SingleBookingResult> {
    const targets = normalizeBookingTargets(schedule);
    if (targets.length !== 1) {
      throw new DooremiError(
        "Each Dooremi booking request must contain exactly one session.",
      );
    }
    const single = singleTargetSchedule(schedule, targets[0]);
    const result = await this.#request(DOOREMI_ENDPOINTS.createBooking, {
      body: bookingPayload(single),
      ambiguousSubmission: true,
    });
    const content = asRecord(result.payload.content) ?? {};
    return {
      message: text(content.message, text(result.payload.msg, "ok")),
      bookingOrderId: numericId(content.bookingOrderId),
    };
  }

  async bookingHistory(
    options: { pageSize?: number; cursor?: string | number } = {},
  ): Promise<BookingRecord[]> {
    const pageSize = options.pageSize ?? 15;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new DooremiError("Booking history page size is invalid.");
    }
    const result = await this.#request(DOOREMI_ENDPOINTS.bookingHistory, {
      query: { id: options.cursor ?? "", pageSize },
    });

    const records: BookingRecord[] = [];
    for (const rawOrder of asArray(result.payload.content)) {
      const order = asRecord(rawOrder);
      if (!order) continue;
      const facilities = asArray(order.facilityList)
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item !== null);
      if (facilities.length === 0) continue;

      const first = facilities[0];
      const id = numericId(order.id) ?? numericId(first.id);
      if (id === null) continue;
      const eventTimes = facilities
        .map((facility) =>
          typeof facility.eventTime === "string"
            ? facility.eventTime.trim()
            : "",
        )
        .filter(Boolean);
      const facilityNames = [
        ...new Set(
          facilities.map((facility) => text(facility.facilityName, "Facility")),
        ),
      ];
      const categoryType = order.categoryType;
      records.push({
        id,
        facilityName: facilityNames.join(" + "),
        eventDay: text(first.eventDate, "—"),
        eventTime: eventTimes.join(" · ") || "—",
        eventTimes,
        status: numericId(first.status),
        statusName: text(first.statusName, "Unknown"),
        canCancel: facilities.every((facility) => Boolean(facility.canCancel)),
        categoryType:
          typeof categoryType === "string" || typeof categoryType === "number"
            ? categoryType
            : null,
      });
    }
    return records;
  }

  async bookingDetail(bookingId: number): Promise<Record<string, unknown>> {
    const id = normalizeFacilityId(bookingId);
    const result = await this.#request(DOOREMI_ENDPOINTS.bookingDetail, {
      query: { orderId: id },
    });
    return asRecord(result.payload.content) ?? {};
  }

  async cancelBooking(bookingId: number): Promise<CancelBookingResult> {
    const id = normalizeFacilityId(bookingId);
    const result = await this.#request(DOOREMI_ENDPOINTS.cancelBooking, {
      query: { bookingId: id },
    });
    const content = asRecord(result.payload.content) ?? {};
    return {
      message: text(content.statusName, text(result.payload.msg, "Booking cancelled")),
      bookingId: numericId(content.id) ?? id,
    };
  }

  async #request(
    path: string,
    options: RequestOptions = {},
  ): Promise<RequestResult> {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const started = this.#monotonicNow();
    try {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
            "User-Agent": this.#userAgent,
          },
          body: JSON.stringify(options.body ?? {}),
          cache: "no-store",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        if (options.ambiguousSubmission) {
          throw new AmbiguousSubmissionError(
            controller.signal.aborted
              ? "Dooremi timed out during booking submission."
              : "The connection ended during booking submission.",
          );
        }
        if (controller.signal.aborted) throw new NetworkTimeoutError();
        throw new ConnectivityError();
      }

      const elapsedMs = Math.round(this.#monotonicNow() - started);
      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError();
      }
      if (response.status === 429) throw new RateLimitError();
      if (response.status >= 500) {
        throw new DooremiError(
          "Dooremi is temporarily unavailable.",
          "api",
          response.status,
        );
      }
      if (!response.ok) {
        throw new DooremiError(
          `Dooremi returned HTTP ${response.status}.`,
          "api",
          response.status,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (options.ambiguousSubmission) throw new AmbiguousSubmissionError();
        if (controller.signal.aborted) throw new NetworkTimeoutError();
        throw new DooremiError("Dooremi returned an unreadable response.");
      }
      const root = asRecord(payload);
      if (!root) {
        if (options.ambiguousSubmission) throw new AmbiguousSubmissionError();
        throw new DooremiError("Dooremi returned an unreadable response.");
      }
      if (root.status !== 0) {
        const message = safeErrorMessage(text(root.msg, "Unknown error"));
        if (isAuthenticationMessage(message)) throw new AuthenticationError();
        throw new DooremiError(
          `Dooremi rejected the request (${String(root.status)}): ${message}`,
          "rejected",
        );
      }
      return { payload: root, headers: response.headers, elapsedMs };
    } finally {
      clearTimeout(timeout);
    }
  }
}
