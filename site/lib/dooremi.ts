import {
  bookingPayload,
  normalizeBookingTargets,
  normalizeEventDay,
  normalizeFacilityId,
  parseAvailabilityPayload,
  singleTargetSchedule,
  type Availability,
  type BookingPayload,
  type BookingRecord,
  type Schedule,
} from "./domain.js";

export const DOOREMI_BASE_URL = "https://api.dooremi.com.sg";
export const DOOREMI_CURRENT_USER_AGENT = "okhttp/4.9.2";
// Retained as a compatibility export for the shared contract and older imports.
export const DOOREMI_IOS_USER_AGENT = DOOREMI_CURRENT_USER_AGENT;
export const DOOREMI_CURRENT_APP_TOKEN_NOT_BEFORE =
  "2026-03-01T00:00:00+08:00";
export const DOOREMI_ENDPOINTS = Object.freeze({
  login: "/user/login",
  checkLogin: "/user/checkLogin",
  mobileSession: "/user/gvs/getSipInfoV2",
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
  | "client_upgrade_required"
  | "rejected"
  | "api"
  | "ambiguous_submission";

export class DooremiError extends Error {
  readonly code: DooremiErrorCode;
  readonly httpStatus: number | null;
  readonly serverDate: Date | null;
  readonly elapsedMs: number | null;

  constructor(
    message: string,
    code: DooremiErrorCode = "api",
    httpStatus: number | null = null,
    serverDate: Date | null = null,
    elapsedMs: number | null = null,
  ) {
    super(message);
    this.name = "DooremiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.serverDate = serverDate;
    this.elapsedMs = elapsedMs;
  }
}

export class AuthenticationError extends DooremiError {
  constructor() {
    super(
      "The Dooremi session is no longer valid. Court Signal will renew it automatically.",
      "authentication",
    );
    this.name = "AuthenticationError";
  }
}

export class DooremiLoginRejectedError extends DooremiError {
  constructor() {
    super(
      "Dooremi rejected the background sign-in credentials.",
      "authentication",
    );
    this.name = "DooremiLoginRejectedError";
  }
}

export class ClientUpgradeRequiredError extends DooremiError {
  constructor(
    message =
      "Dooremi requires a current-app session before it will create bookings. Court Signal must complete background sign-in before retrying.",
    httpStatus: number | null = null,
    serverDate: Date | null = null,
    elapsedMs: number | null = null,
  ) {
    super(
      message,
      "client_upgrade_required",
      httpStatus,
      serverDate,
      elapsedMs,
    );
    this.name = "ClientUpgradeRequiredError";
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
  const original =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "Unexpected error";
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
  /** Provider round-trip for createOrderV2 only; preview latency is separate. */
  elapsedMs?: number;
  serverDate?: Date | null;
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

export interface BookingPreparationResult {
  message: string;
  facilityName: string | null;
  eventDay: string;
  eventTime: string;
  bookingFeeAmount: number | string | null;
  bookingFeeRequired: boolean;
  hasPayNow: boolean | null;
  managementPaymentSelected: boolean;
  elapsedMs: number;
  serverDate: Date | null;
  cached: boolean;
}

export type BookingCredentialStatus =
  | "current"
  | "upgrade_required"
  | "unknown";

export interface BookingCredentialInfo {
  status: BookingCredentialStatus;
  issuedAt: string | null;
  minimumIssuedAt: string;
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
  /** Mobile HTTP session cookies, encrypted alongside the token by the manager. */
  cookieHeader?: string | null;
  onCookieHeaderChange?: (cookieHeader: string | null) => void;
}

export interface DooremiLoginOptions {
  userName: string;
  password: string;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
}

export interface DooremiLoginResult {
  token: string;
  issuedAt: string | null;
  sessionCookieHeader: string | null;
}

interface RequestOptions {
  query?: Record<string, string | number>;
  body?: unknown;
  ambiguousSubmission?: boolean;
  timeoutMs?: number;
}

interface RequestResult {
  payload: Record<string, unknown>;
  headers: Headers;
  elapsedMs: number;
}

type BookingCreatePayload = BookingPayload & {
  /** The current app sends an empty value when a fee is handled by management. */
  paymentType?: "";
};

interface PreparedBooking {
  body: BookingCreatePayload;
  result: Omit<BookingPreparationResult, "cached">;
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

function safeAmount(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.length <= 32 &&
    /^\d+(?:\.\d+)?$/.test(value)
  ) {
    return value;
  }
  return null;
}

function isAuthenticationMessage(message: string): boolean {
  const lower = message.toLocaleLowerCase("en");
  return ["login", "token", "expired", "unauthorized"].some((word) =>
    lower.includes(word),
  );
}

function isClientUpgradeMessage(message: string): boolean {
  return /update\s+(?:to\s+)?the\s+latest\s+version|latest\s+version.*(?:booking|payment)/i.test(
    message,
  );
}

function jwtCreatedAt(token: string): Date | null {
  const encoded = token.split(".")[1];
  if (!encoded) return null;
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const payload = asRecord(JSON.parse(globalThis.atob(padded)));
    const raw = payload?.ct;
    if (typeof raw === "string" && raw.trim() && !/^\d+(?:\.\d+)?$/.test(raw)) {
      const parsed = new Date(raw);
      return Number.isNaN(parsed.valueOf()) ? null : parsed;
    }
    const numeric = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const parsed = new Date(numeric < 100_000_000_000 ? numeric * 1_000 : numeric);
    return Number.isNaN(parsed.valueOf()) ? null : parsed;
  } catch {
    return null;
  }
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

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function splitSetCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const separate = extended.getSetCookie?.();
  if (separate?.length) return separate;
  const combined = headers.get("set-cookie");
  return combined
    ? combined.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/g)
    : [];
}

function parseCookieHeader(header: string | null | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (COOKIE_NAME.test(name) && !/[;\u0000-\u001f\u007f]/.test(value)) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function absorbResponseCookies(cookies: Map<string, string>, headers: Headers): void {
  for (const setCookie of splitSetCookieHeaders(headers)) {
    const pair = setCookie.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!COOKIE_NAME.test(name) || /[;\u0000-\u001f\u007f]/.test(value)) continue;
    if (/;\s*max-age\s*=\s*0(?:\s*;|\s*$)/i.test(setCookie)) {
      cookies.delete(name);
    } else {
      cookies.set(name, value);
    }
  }
}

function serializeCookies(cookies: Map<string, string>): string | null {
  const value = [...cookies.entries()]
    .map(([name, cookie]) => `${name}=${cookie}`)
    .join("; ");
  return value || null;
}

/**
 * Signs in using the current provider-app contract. The username and password
 * are used only for this request and are never included in results or errors.
 */
export async function loginDooremi(
  options: DooremiLoginOptions,
): Promise<DooremiLoginResult> {
  if (!options.userName.trim() || !options.password) {
    throw new DooremiLoginRejectedError();
  }
  const timeoutMs = options.timeoutMs ?? 12_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new DooremiError("The Dooremi timeout must be greater than zero.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(
        new URL(DOOREMI_ENDPOINTS.login, options.baseUrl ?? DOOREMI_BASE_URL),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": options.userAgent ?? DOOREMI_CURRENT_USER_AGENT,
          },
          body: JSON.stringify({
            userName: options.userName,
            password: options.password,
          }),
          cache: "no-store",
          redirect: "manual",
          signal: controller.signal,
        },
      );
    } catch {
      if (controller.signal.aborted) throw new NetworkTimeoutError();
      throw new ConnectivityError();
    }

    if (response.status === 401 || response.status === 403) {
      throw new DooremiLoginRejectedError();
    }
    if (response.status === 429) throw new RateLimitError();
    if (response.status >= 500) {
      throw new DooremiError(
        "Dooremi is temporarily unavailable during background sign-in.",
        "api",
        response.status,
      );
    }
    if (!response.ok) {
      throw new DooremiError(
        `Dooremi returned HTTP ${response.status} during background sign-in.`,
        "api",
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new DooremiError(
        "Dooremi returned an unreadable background sign-in response.",
      );
    }
    const root = asRecord(payload);
    if (!root || root.status !== 0) throw new DooremiLoginRejectedError();
    const content = asRecord(root.content);
    const token = typeof content?.token === "string" ? content.token : "";
    validateRawToken(token);
    const issuedAt = jwtCreatedAt(token)?.toISOString() ?? null;
    const cookies = new Map<string, string>();
    absorbResponseCookies(cookies, response.headers);
    return { token, issuedAt, sessionCookieHeader: serializeCookies(cookies) };
  } finally {
    clearTimeout(timeout);
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
  readonly #cookies: Map<string, string>;
  readonly #onCookieHeaderChange?: (cookieHeader: string | null) => void;
  readonly #preparedBookings = new Map<string, Promise<PreparedBooking>>();

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
    this.#cookies = parseCookieHeader(options.cookieHeader);
    this.#onCookieHeaderChange = options.onCookieHeaderChange;
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
      cookieHeader: serializeCookies(this.#cookies),
      onCookieHeaderChange: this.#onCookieHeaderChange,
    });
  }

  sessionCookieCount(): number {
    return this.#cookies.size;
  }

  bookingCredential(): BookingCredentialInfo {
    const issuedAt = jwtCreatedAt(this.#token);
    const minimumIssuedAt = new Date(
      DOOREMI_CURRENT_APP_TOKEN_NOT_BEFORE,
    );
    return {
      status:
        issuedAt === null
          ? "unknown"
          : issuedAt.valueOf() < minimumIssuedAt.valueOf()
            ? "upgrade_required"
            : "current",
      issuedAt: issuedAt?.toISOString() ?? null,
      minimumIssuedAt: minimumIssuedAt.toISOString(),
    };
  }

  /** Fails before history reads, cancellation, or booking submission. */
  assertBookingCredentialCurrent(): void {
    const credential = this.bookingCredential();
    if (credential.status !== "upgrade_required") return;
    throw new ClientUpgradeRequiredError(
      `The available Dooremi session was issued on ${credential.issuedAt} before the current-app migration and is rejected for booking writes. Background sign-in must renew it before the next release. No booking was changed.`,
    );
  }

  async warmup(options: { timeoutMs?: number } = {}): Promise<WarmupResult> {
    const result = await this.#request(DOOREMI_ENDPOINTS.checkLogin, {
      timeoutMs: options.timeoutMs,
    });
    const header = result.headers.get("date");
    const parsed = header ? new Date(header) : null;
    return {
      elapsedMs: result.elapsedMs,
      serverDate: parsed && !Number.isNaN(parsed.valueOf()) ? parsed : null,
    };
  }

  /** Mirrors the current app's safe post-login Home initialization request. */
  async initializeMobileSession(): Promise<WarmupResult> {
    const result = await this.#request(DOOREMI_ENDPOINTS.mobileSession);
    return {
      elapsedMs: result.elapsedMs,
      serverDate: this.#serverDate(result.headers),
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
      normalizeBookingTargets(schedule).map((target) =>
        this.prepareSingleBooking(singleTargetSchedule(schedule, target)),
      ),
    );
    return {
      message: previews[0]?.message ?? "ok",
      facilityName: previews[0]?.facilityName ?? null,
      eventDay: previews[0]?.eventDay ?? normalizeEventDay(schedule.eventDay),
      eventTimes: previews.map((item) => item.eventTime),
    };
  }

  /**
   * Mirrors the current Dooremi app's required orderPreview -> createOrderV2
   * flow. This is read-only and caches the derived create payload so a safe
   * retry never repeats a successful preview or adds latency twice.
   */
  async prepareSingleBooking(
    schedule: Schedule,
  ): Promise<BookingPreparationResult> {
    this.assertBookingCredentialCurrent();
    const { key, single, body } = this.#singleBookingSpec(schedule);
    const existing = this.#preparedBookings.get(key);
    if (existing) {
      return { ...(await existing).result, cached: true };
    }

    const pending = this.#loadBookingPreparation(single, body);
    this.#preparedBookings.set(key, pending);
    try {
      return { ...(await pending).result, cached: false };
    } catch (error) {
      // A rejected or failed preview must be eligible for the transaction's
      // bounded explicit-rejection retry policy.
      if (this.#preparedBookings.get(key) === pending) {
        this.#preparedBookings.delete(key);
      }
      throw error;
    }
  }

  async createSingleBooking(schedule: Schedule): Promise<SingleBookingResult> {
    this.assertBookingCredentialCurrent();
    const { key } = this.#singleBookingSpec(schedule);
    // Direct callers are safe too: if the transaction did not explicitly
    // prepare this target, createSingleBooking performs the preview first.
    await this.prepareSingleBooking(schedule);
    const prepared = await this.#preparedBookings.get(key);
    if (!prepared) {
      throw new DooremiError("The Dooremi booking preview was not retained.");
    }
    const result = await this.#request(DOOREMI_ENDPOINTS.createBooking, {
      body: prepared.body,
      ambiguousSubmission: true,
    });
    const content = asRecord(result.payload.content) ?? {};
    return {
      message: text(content.message, text(result.payload.msg, "ok")),
      bookingOrderId: numericId(content.bookingOrderId),
      elapsedMs: result.elapsedMs,
      serverDate: this.#serverDate(result.headers),
    };
  }

  #singleBookingSpec(schedule: Schedule): {
    key: string;
    single: Schedule;
    body: BookingPayload;
  } {
    const targets = normalizeBookingTargets(schedule);
    if (targets.length !== 1) {
      throw new DooremiError(
        "Each Dooremi booking request must contain exactly one session.",
      );
    }
    const single = singleTargetSchedule(schedule, targets[0]);
    const body = bookingPayload(single);
    return {
      key: `${body.eventDay}\u0000${targets[0].eventTime}\u0000${targets[0].facilityId}`,
      single,
      body,
    };
  }

  async #loadBookingPreparation(
    single: Schedule,
    baseBody: BookingPayload,
  ): Promise<PreparedBooking> {
    const result = await this.#request(DOOREMI_ENDPOINTS.preview, {
      body: baseBody,
    });
    const content = asRecord(result.payload.content) ?? {};
    const facility =
      asRecord(asArray(content.bookingOrderFacilityList)[0]) ?? {};
    // Match the current React Native app's JavaScript truthiness check. When a
    // booking fee is present, its "via Management" path sends paymentType: "".
    const bookingFeeRequired = Boolean(content.bookingFeeAmount);
    const body: BookingCreatePayload = bookingFeeRequired
      ? { ...baseBody, paymentType: "" }
      : baseBody;
    return {
      body,
      result: {
        message: text(result.payload.msg, "ok"),
        facilityName:
          typeof facility.facilityName === "string"
            ? facility.facilityName
            : typeof content.facilityName === "string"
              ? content.facilityName
              : null,
        eventDay: text(facility.eventDate, single.eventDay),
        eventTime: text(
          facility.eventTime,
          normalizeBookingTargets(single)[0].eventTime,
        ),
        bookingFeeAmount: safeAmount(content.bookingFeeAmount),
        bookingFeeRequired,
        hasPayNow:
          typeof content.hasPayNow === "boolean" ? content.hasPayNow : null,
        managementPaymentSelected: bookingFeeRequired,
        elapsedMs: result.elapsedMs,
        serverDate: this.#serverDate(result.headers),
      },
    };
  }

  #serverDate(headers: Headers): Date | null {
    const header = headers.get("date");
    const parsed = header ? new Date(header) : null;
    return parsed && !Number.isNaN(parsed.valueOf()) ? parsed : null;
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

    const requestTimeoutMs = options.timeoutMs ?? this.#timeoutMs;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new DooremiError("The Dooremi timeout must be greater than zero.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const started = this.#monotonicNow();
    try {
      let response: Response;
      try {
        const cookieHeader = serializeCookies(this.#cookies);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": this.#userAgent,
        };
        if (cookieHeader) headers.Cookie = cookieHeader;
        response = await this.#fetch(url, {
          method: "POST",
          headers,
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
      const beforeCookies = serializeCookies(this.#cookies);
      absorbResponseCookies(this.#cookies, response.headers);
      const afterCookies = serializeCookies(this.#cookies);
      if (afterCookies !== beforeCookies) this.#onCookieHeaderChange?.(afterCookies);
      const dateHeader = response.headers.get("date");
      const parsedServerDate = dateHeader ? new Date(dateHeader) : null;
      const serverDate =
        parsedServerDate && !Number.isNaN(parsedServerDate.valueOf())
          ? parsedServerDate
          : null;
      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError();
      }
      if (response.status === 429) throw new RateLimitError();
      if (response.status >= 500) {
        if (options.ambiguousSubmission) {
          throw new AmbiguousSubmissionError(
            `Dooremi returned HTTP ${response.status} during booking submission.`,
          );
        }
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
        if (isClientUpgradeMessage(message)) {
          throw new ClientUpgradeRequiredError(
            `Dooremi rejected the current booking/payment flow: ${message} This response does not by itself prove that the token expired, so Court Signal did not blindly retry it.`,
            response.status,
            serverDate,
            elapsedMs,
          );
        }
        throw new DooremiError(
          `Dooremi rejected the request (${String(root.status)}): ${message}`,
          "rejected",
          response.status,
          serverDate,
          elapsedMs,
        );
      }
      return { payload: root, headers: response.headers, elapsedMs };
    } finally {
      clearTimeout(timeout);
    }
  }
}
