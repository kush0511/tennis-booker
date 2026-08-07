import contract from "../../shared/booking-contract.json";
import type {
  ProviderCredentialStore,
  ProviderCredentialSuccess,
  StoredProviderCredential,
} from "../lib/dooremi-session";
import { getRuntimeEnv } from "./index";

export type UserSettings = {
  facilityId: number;
  facilityCategoryId: number;
  bookingLeadDays: number;
  releaseHour: number;
  releaseMinute: number;
  cancellationLeadSeconds: number;
  fireDelayMilliseconds: number;
  maximumSessions: number;
};

export type StoredSchedule = {
  id: string;
  userEmail: string;
  eventDay: string;
  eventTimes: string[];
  facilityId: number;
  facilityCategoryId: number;
  releaseAt: string;
  status: string;
  claimedAt: string | null;
  leaseUntil: string | null;
  attemptedAt: string | null;
  resultMessage: string | null;
  bookingOrderIds: number[];
  preparedTargets: unknown[];
  submittedTargets: unknown[];
  cancelledBookingIds: number[];
  submitSkewMs: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleEvent = {
  id: number;
  level: "info" | "warning" | "error";
  message: string;
  createdAt: string;
};

export type AutomationHeartbeat = {
  lastSeenAt: string;
  scheduledAt: string;
  cron: string;
};

type ScheduleRow = {
  id: string;
  user_email: string;
  event_day: string;
  event_times_json: string;
  facility_id: number;
  facility_category_id: number;
  release_at: string;
  status: string;
  claimed_at: string | null;
  lease_until: string | null;
  attempted_at: string | null;
  result_message: string | null;
  booking_order_ids_json: string;
  prepared_targets_json: string | null;
  submitted_targets_json: string | null;
  cancelled_booking_ids_json: string;
  submit_skew_ms: number | null;
  created_at: string;
  updated_at: string;
};

let schemaPromise: Promise<void> | null = null;

function database(): D1Database {
  const db = getRuntimeEnv().DB;
  if (!db) throw new Error("Persistent storage is not configured.");
  return db;
}

export function defaultSettings(): UserSettings {
  const runtime = getRuntimeEnv();
  return {
    facilityId: Number(runtime.DOOREMI_FACILITY_ID || 0),
    facilityCategoryId: Number(runtime.DOOREMI_CATEGORY_ID || 0),
    bookingLeadDays: contract.defaults.bookingLeadDays,
    releaseHour: contract.defaults.releaseHour,
    releaseMinute: contract.defaults.releaseMinute,
    cancellationLeadSeconds: contract.defaults.cancellationLeadSeconds,
    fireDelayMilliseconds: contract.defaults.fireDelayMilliseconds,
    maximumSessions: contract.defaults.maximumSessions,
  };
}

export function ensureSchema(): Promise<void> {
  if (schemaPromise) return schemaPromise;
  const db = database();
  schemaPromise = db
    .batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS user_settings (
        user_email TEXT PRIMARY KEY,
        facility_id INTEGER NOT NULL,
        facility_category_id INTEGER NOT NULL,
        booking_lead_days INTEGER NOT NULL DEFAULT 14,
        release_hour INTEGER NOT NULL DEFAULT 12,
        release_minute INTEGER NOT NULL DEFAULT 0,
        cancellation_lead_seconds INTEGER NOT NULL DEFAULT 15,
        fire_delay_milliseconds INTEGER NOT NULL DEFAULT 10,
        maximum_sessions INTEGER NOT NULL DEFAULT 6,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        user_email TEXT NOT NULL,
        event_day TEXT NOT NULL,
        event_times_json TEXT NOT NULL,
        facility_id INTEGER NOT NULL,
        facility_category_id INTEGER NOT NULL,
        release_at TEXT NOT NULL,
        status TEXT NOT NULL,
        claimed_at TEXT,
        lease_until TEXT,
        attempted_at TEXT,
        result_message TEXT,
        booking_order_ids_json TEXT NOT NULL DEFAULT '[]',
        prepared_targets_json TEXT,
        submitted_targets_json TEXT,
        cancelled_booking_ids_json TEXT NOT NULL DEFAULT '[]',
        submit_skew_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS schedules_user_release_idx
        ON schedules (user_email, release_at DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS schedules_due_idx
        ON schedules (status, release_at)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS schedule_slots (
        user_email TEXT NOT NULL,
        event_day TEXT NOT NULL,
        event_time TEXT NOT NULL,
        facility_id INTEGER NOT NULL,
        schedule_id TEXT NOT NULL,
        PRIMARY KEY (user_email, event_day, event_time, facility_id)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS schedule_windows (
        user_email TEXT NOT NULL,
        release_at TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        PRIMARY KEY (user_email, release_at)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS schedule_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL,
        user_email TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS schedule_events_schedule_idx
        ON schedule_events (schedule_id, created_at DESC)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS automation_heartbeat (
        id TEXT PRIMARY KEY,
        last_seen_at TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        cron TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS schedule_failure_exports (
        schedule_id TEXT PRIMARY KEY,
        exported_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS provider_credentials (
        provider TEXT PRIMARY KEY,
        token_ciphertext TEXT,
        token_iv TEXT,
        encryption_version INTEGER,
        issued_at TEXT,
        refreshed_at TEXT,
        last_validated_at TEXT,
        last_refresh_attempt_at TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        last_error_message TEXT,
        refresh_lease_until TEXT,
        login_identifier_kind TEXT,
        updated_at TEXT NOT NULL
      )`),
    ])
    .then(() => undefined)
    .catch((error) => {
      schemaPromise = null;
      throw error;
    });
  return schemaPromise;
}

type ProviderCredentialRow = {
  provider: string;
  token_ciphertext: string | null;
  token_iv: string | null;
  encryption_version: number | null;
  issued_at: string | null;
  refreshed_at: string | null;
  last_validated_at: string | null;
  last_refresh_attempt_at: string | null;
  consecutive_failures: number;
  last_error_code: string | null;
  last_error_message: string | null;
  refresh_lease_until: string | null;
  login_identifier_kind: "phone" | "email" | "other" | null;
  updated_at: string;
};

export async function getProviderCredential(
  provider: string,
): Promise<StoredProviderCredential | null> {
  await ensureSchema();
  const row = await database()
    .prepare(`SELECT * FROM provider_credentials WHERE provider = ?`)
    .bind(provider)
    .first<ProviderCredentialRow>();
  return row ? fromProviderCredentialRow(row) : null;
}

export async function claimProviderCredentialRefresh(
  provider: string,
  nowIso: string,
  leaseUntilIso: string,
): Promise<boolean> {
  await ensureSchema();
  const result = await database()
    .prepare(`INSERT INTO provider_credentials (
      provider, last_refresh_attempt_at, consecutive_failures,
      refresh_lease_until, updated_at
    ) VALUES (?, ?, 0, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      last_refresh_attempt_at = excluded.last_refresh_attempt_at,
      refresh_lease_until = excluded.refresh_lease_until,
      updated_at = excluded.updated_at
    WHERE provider_credentials.refresh_lease_until IS NULL
      OR provider_credentials.refresh_lease_until < ?`)
    .bind(provider, nowIso, leaseUntilIso, nowIso, nowIso)
    .run();
  return Number(result.meta.changes || 0) === 1;
}

export async function saveProviderCredentialSuccess(
  provider: string,
  success: ProviderCredentialSuccess,
): Promise<void> {
  await ensureSchema();
  await database()
    .prepare(`INSERT INTO provider_credentials (
      provider, token_ciphertext, token_iv, encryption_version, issued_at,
      refreshed_at, last_validated_at, last_refresh_attempt_at,
      consecutive_failures, last_error_code, last_error_message,
      refresh_lease_until, login_identifier_kind, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      token_ciphertext = excluded.token_ciphertext,
      token_iv = excluded.token_iv,
      encryption_version = excluded.encryption_version,
      issued_at = excluded.issued_at,
      refreshed_at = excluded.refreshed_at,
      last_validated_at = excluded.last_validated_at,
      last_refresh_attempt_at = excluded.last_refresh_attempt_at,
      consecutive_failures = 0,
      last_error_code = NULL,
      last_error_message = NULL,
      refresh_lease_until = NULL,
      login_identifier_kind = excluded.login_identifier_kind,
      updated_at = excluded.updated_at`)
    .bind(
      provider,
      success.tokenCiphertext,
      success.tokenIv,
      success.encryptionVersion,
      success.issuedAt,
      success.refreshedAt,
      success.lastValidatedAt,
      success.refreshedAt,
      success.loginIdentifierKind,
      success.refreshedAt,
    )
    .run();
}

export async function recordProviderCredentialFailure(
  provider: string,
  attemptedAt: string,
  code: string,
  message: string,
): Promise<void> {
  await ensureSchema();
  const sanitizedCode = code.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64);
  const sanitizedMessage = message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .slice(0, 320);
  await database()
    .prepare(`INSERT INTO provider_credentials (
      provider, last_refresh_attempt_at, consecutive_failures,
      last_error_code, last_error_message, refresh_lease_until, updated_at
    ) VALUES (?, ?, 1, ?, ?, NULL, ?)
    ON CONFLICT(provider) DO UPDATE SET
      last_refresh_attempt_at = excluded.last_refresh_attempt_at,
      consecutive_failures = provider_credentials.consecutive_failures + 1,
      last_error_code = excluded.last_error_code,
      last_error_message = excluded.last_error_message,
      refresh_lease_until = NULL,
      updated_at = excluded.updated_at`)
    .bind(
      provider,
      attemptedAt,
      sanitizedCode,
      sanitizedMessage,
      attemptedAt,
    )
    .run();
}

export async function recordProviderCredentialValidation(
  provider: string,
  validatedAt: string,
): Promise<void> {
  await ensureSchema();
  await database()
    .prepare(`UPDATE provider_credentials SET
      last_validated_at = ?, consecutive_failures = 0,
      last_error_code = NULL, last_error_message = NULL, updated_at = ?
      WHERE provider = ?`)
    .bind(validatedAt, validatedAt, provider)
    .run();
}

export const providerCredentialStore: ProviderCredentialStore = {
  read: getProviderCredential,
  claimRefresh: claimProviderCredentialRefresh,
  saveSuccess: saveProviderCredentialSuccess,
  recordFailure: recordProviderCredentialFailure,
  recordValidation: recordProviderCredentialValidation,
};

export async function getSettings(userEmail: string): Promise<UserSettings> {
  await ensureSchema();
  const row = await database()
    .prepare(`SELECT * FROM user_settings WHERE user_email = ?`)
    .bind(userEmail)
    .first<Record<string, unknown>>();
  if (!row) return defaultSettings();
  return {
    facilityId: Number(row.facility_id),
    facilityCategoryId: Number(row.facility_category_id),
    bookingLeadDays: Number(row.booking_lead_days),
    releaseHour: Number(row.release_hour),
    releaseMinute: Number(row.release_minute),
    cancellationLeadSeconds: Number(row.cancellation_lead_seconds),
    fireDelayMilliseconds: Number(row.fire_delay_milliseconds),
    maximumSessions: Number(row.maximum_sessions),
  };
}

export async function saveSettings(
  userEmail: string,
  settings: UserSettings,
): Promise<UserSettings> {
  await ensureSchema();
  const now = new Date().toISOString();
  await database()
    .prepare(`INSERT INTO user_settings (
      user_email, facility_id, facility_category_id, booking_lead_days,
      release_hour, release_minute, cancellation_lead_seconds,
      fire_delay_milliseconds, maximum_sessions, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_email) DO UPDATE SET
      facility_id = excluded.facility_id,
      facility_category_id = excluded.facility_category_id,
      booking_lead_days = excluded.booking_lead_days,
      release_hour = excluded.release_hour,
      release_minute = excluded.release_minute,
      cancellation_lead_seconds = excluded.cancellation_lead_seconds,
      fire_delay_milliseconds = excluded.fire_delay_milliseconds,
      maximum_sessions = excluded.maximum_sessions,
      updated_at = excluded.updated_at`)
    .bind(
      userEmail,
      settings.facilityId,
      settings.facilityCategoryId,
      settings.bookingLeadDays,
      settings.releaseHour,
      settings.releaseMinute,
      settings.cancellationLeadSeconds,
      settings.fireDelayMilliseconds,
      settings.maximumSessions,
      now,
      now,
    )
    .run();
  return settings;
}

export async function createSchedule(
  schedule: Omit<StoredSchedule, "claimedAt" | "leaseUntil" | "attemptedAt" | "resultMessage" | "bookingOrderIds" | "preparedTargets" | "submittedTargets" | "cancelledBookingIds" | "submitSkewMs" | "createdAt" | "updatedAt">,
): Promise<StoredSchedule> {
  await ensureSchema();
  const db = database();
  const now = new Date().toISOString();
  const statements = [
    db
      .prepare(`INSERT INTO schedules (
        id, user_email, event_day, event_times_json, facility_id,
        facility_category_id, release_at, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        schedule.id,
        schedule.userEmail,
        schedule.eventDay,
        JSON.stringify(schedule.eventTimes),
        schedule.facilityId,
        schedule.facilityCategoryId,
        schedule.releaseAt,
        schedule.status,
        now,
        now,
      ),
    ...schedule.eventTimes.map((eventTime) =>
      db
        .prepare(`INSERT INTO schedule_slots (
          user_email, event_day, event_time, facility_id, schedule_id
        ) VALUES (?, ?, ?, ?, ?)`)
        .bind(
          schedule.userEmail,
          schedule.eventDay,
          eventTime,
          schedule.facilityId,
          schedule.id,
        ),
    ),
    db
      .prepare(`INSERT INTO schedule_windows (
        user_email, release_at, schedule_id
      ) VALUES (?, ?, ?)`)
      .bind(schedule.userEmail, schedule.releaseAt, schedule.id),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    if (/unique|constraint/i.test(String(error))) {
      throw new Error(
        "Those sessions or that release window already have an active plan.",
      );
    }
    throw error;
  }
  return {
    ...schedule,
    claimedAt: null,
    leaseUntil: null,
    attemptedAt: null,
    resultMessage: null,
    bookingOrderIds: [],
    preparedTargets: [],
    submittedTargets: [],
    cancelledBookingIds: [],
    submitSkewMs: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listSchedules(
  userEmail: string,
  limit = 30,
): Promise<StoredSchedule[]> {
  await ensureSchema();
  const result = await database()
    .prepare(`SELECT * FROM schedules
      WHERE user_email = ?
      ORDER BY release_at DESC
      LIMIT ?`)
    .bind(userEmail, limit)
    .all<ScheduleRow>();
  return result.results.map(fromScheduleRow);
}

export async function listUnreportedScheduleFailures(
  limit = 20,
): Promise<StoredSchedule[]> {
  await ensureSchema();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Failure export limit must be between 1 and 100.");
  }
  const result = await database()
    .prepare(`SELECT schedules.* FROM schedules
      LEFT JOIN schedule_failure_exports
        ON schedule_failure_exports.schedule_id = schedules.id
      WHERE schedules.status IN ('failed', 'partial', 'missed')
        AND schedule_failure_exports.schedule_id IS NULL
      ORDER BY schedules.updated_at DESC
      LIMIT ?`)
    .bind(limit)
    .all<ScheduleRow>();
  return result.results.map(fromScheduleRow);
}

export async function markScheduleFailureReported(id: string): Promise<void> {
  await ensureSchema();
  await database()
    .prepare(`INSERT OR IGNORE INTO schedule_failure_exports (
      schedule_id, exported_at
    ) VALUES (?, ?)`)
    .bind(id, new Date().toISOString())
    .run();
}

export async function getSchedule(
  id: string,
  userEmail?: string,
): Promise<StoredSchedule | null> {
  await ensureSchema();
  const statement = userEmail
    ? database()
        .prepare(`SELECT * FROM schedules WHERE id = ? AND user_email = ?`)
        .bind(id, userEmail)
    : database().prepare(`SELECT * FROM schedules WHERE id = ?`).bind(id);
  const row = await statement.first<ScheduleRow>();
  return row ? fromScheduleRow(row) : null;
}

export async function cancelSchedule(
  id: string,
  userEmail: string,
): Promise<boolean> {
  await ensureSchema();
  const db = database();
  const now = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(`UPDATE schedules SET status = 'cancelled', updated_at = ?
        WHERE id = ? AND user_email = ? AND status = 'pending'`)
      .bind(now, id, userEmail),
    db
      .prepare(`DELETE FROM schedule_slots
        WHERE schedule_id = ? AND EXISTS (
          SELECT 1 FROM schedules
          WHERE id = ? AND user_email = ? AND status = 'cancelled'
      )`)
      .bind(id, id, userEmail),
    db
      .prepare(`DELETE FROM schedule_windows
        WHERE schedule_id = ? AND EXISTS (
          SELECT 1 FROM schedules
          WHERE id = ? AND user_email = ? AND status = 'cancelled'
        )`)
      .bind(id, id, userEmail),
  ]);
  return Number(results[0].meta.changes || 0) === 1;
}

export async function listDueSchedules(
  nowIso: string,
  armingWindowSeconds: number,
): Promise<StoredSchedule[]> {
  await ensureSchema();
  const latest = new Date(
    new Date(nowIso).getTime() + armingWindowSeconds * 1000,
  ).toISOString();
  const result = await database()
    .prepare(`SELECT * FROM schedules
      WHERE release_at <= ? AND (
        status = 'pending' OR
        (status = 'running' AND lease_until < ?)
      )
      ORDER BY release_at ASC`)
    .bind(latest, nowIso)
    .all<ScheduleRow>();
  return result.results.map(fromScheduleRow);
}

export async function claimSchedule(
  id: string,
  leaseSeconds = 180,
): Promise<StoredSchedule | null> {
  await ensureSchema();
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const result = await database()
    .prepare(`UPDATE schedules SET
      status = 'running', claimed_at = ?, lease_until = ?,
      attempted_at = COALESCE(attempted_at, ?), updated_at = ?
      WHERE id = ? AND (
        status = 'pending' OR
        (status = 'running' AND lease_until < ?)
      )`)
    .bind(nowIso, leaseUntil, nowIso, nowIso, id, nowIso)
    .run();
  if (Number(result.meta.changes || 0) !== 1) return null;
  return getSchedule(id);
}

export async function finishSchedule(
  id: string,
  patch: {
    status: "succeeded" | "partial" | "failed" | "missed";
    resultMessage: string;
    bookingOrderIds?: number[];
    preparedTargets?: unknown[];
    submittedTargets?: unknown[];
    cancelledBookingIds?: number[];
    submitSkewMs?: number | null;
  },
): Promise<void> {
  await ensureSchema();
  const db = database();
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(`UPDATE schedules SET
        status = ?, result_message = ?, booking_order_ids_json = ?,
        prepared_targets_json = ?, submitted_targets_json = ?,
        cancelled_booking_ids_json = ?, submit_skew_ms = ?,
        lease_until = NULL, updated_at = ?
        WHERE id = ?`)
      .bind(
        patch.status,
        patch.resultMessage,
        JSON.stringify(patch.bookingOrderIds || []),
        JSON.stringify(patch.preparedTargets || []),
        JSON.stringify(patch.submittedTargets || []),
        JSON.stringify(patch.cancelledBookingIds || []),
        patch.submitSkewMs ?? null,
        now,
        id,
      ),
    db.prepare(`DELETE FROM schedule_slots WHERE schedule_id = ?`).bind(id),
    db.prepare(`DELETE FROM schedule_windows WHERE schedule_id = ?`).bind(id),
  ]);
}

export async function appendScheduleEvent(
  scheduleId: string,
  userEmail: string,
  level: "info" | "warning" | "error",
  message: string,
): Promise<void> {
  await ensureSchema();
  const sanitized = message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .slice(0, 600);
  await database()
    .prepare(`INSERT INTO schedule_events (
      schedule_id, user_email, level, message, created_at
    ) VALUES (?, ?, ?, ?, ?)`)
    .bind(
      scheduleId,
      userEmail,
      level,
      sanitized,
      new Date().toISOString(),
    )
    .run();
}

export async function listScheduleEvents(
  scheduleId: string,
  userEmail: string,
  limit = 40,
): Promise<ScheduleEvent[]> {
  await ensureSchema();
  const result = await database()
    .prepare(`SELECT id, level, message, created_at
      FROM schedule_events
      WHERE schedule_id = ? AND user_email = ?
      ORDER BY created_at DESC
      LIMIT ?`)
    .bind(scheduleId, userEmail, limit)
    .all<{
      id: number;
      level: "info" | "warning" | "error";
      message: string;
      created_at: string;
    }>();
  return result.results.map((event) => ({
    id: event.id,
    level: event.level,
    message: event.message,
    createdAt: event.created_at,
  }));
}

export async function recordAutomationHeartbeat(
  heartbeat: AutomationHeartbeat,
): Promise<void> {
  await ensureSchema();
  await database()
    .prepare(`INSERT INTO automation_heartbeat (
      id, last_seen_at, scheduled_at, cron
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      scheduled_at = excluded.scheduled_at,
      cron = excluded.cron`)
    .bind(
      "runner",
      heartbeat.lastSeenAt,
      heartbeat.scheduledAt,
      heartbeat.cron,
    )
    .run();
}

export async function getAutomationHeartbeat(): Promise<AutomationHeartbeat | null> {
  await ensureSchema();
  const heartbeat = await database()
    .prepare(`SELECT last_seen_at, scheduled_at, cron
      FROM automation_heartbeat WHERE id = ?`)
    .bind("runner")
    .first<{
      last_seen_at: string;
      scheduled_at: string;
      cron: string;
    }>();
  return heartbeat
    ? {
        lastSeenAt: heartbeat.last_seen_at,
        scheduledAt: heartbeat.scheduled_at,
        cron: heartbeat.cron,
      }
    : null;
}

function fromScheduleRow(row: ScheduleRow): StoredSchedule {
  return {
    id: row.id,
    userEmail: row.user_email,
    eventDay: row.event_day,
    eventTimes: parseArray<string>(row.event_times_json),
    facilityId: row.facility_id,
    facilityCategoryId: row.facility_category_id,
    releaseAt: row.release_at,
    status: row.status,
    claimedAt: row.claimed_at,
    leaseUntil: row.lease_until,
    attemptedAt: row.attempted_at,
    resultMessage: row.result_message,
    bookingOrderIds: parseArray<number>(row.booking_order_ids_json),
    preparedTargets: parseArray<unknown>(row.prepared_targets_json),
    submittedTargets: parseArray<unknown>(row.submitted_targets_json),
    cancelledBookingIds: parseArray<number>(row.cancelled_booking_ids_json),
    submitSkewMs: row.submit_skew_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromProviderCredentialRow(
  row: ProviderCredentialRow,
): StoredProviderCredential {
  return {
    provider: row.provider,
    tokenCiphertext: row.token_ciphertext,
    tokenIv: row.token_iv,
    encryptionVersion: row.encryption_version,
    issuedAt: row.issued_at,
    refreshedAt: row.refreshed_at,
    lastValidatedAt: row.last_validated_at,
    lastRefreshAttemptAt: row.last_refresh_attempt_at,
    consecutiveFailures: row.consecutive_failures,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    refreshLeaseUntil: row.refresh_lease_until,
    loginIdentifierKind: row.login_identifier_kind,
    updatedAt: row.updated_at,
  };
}

function parseArray<T>(value: string | null): T[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
