import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type TennisRuntimeEnv = {
  DB: D1Database;
  DOOREMI_BEARER_TOKEN?: string;
  DOOREMI_USERNAME?: string;
  DOOREMI_USERNAME_FALLBACK?: string;
  DOOREMI_PASSWORD?: string;
  DOOREMI_TOKEN_ENCRYPTION_KEY?: string;
  DOOREMI_FACILITY_ID?: string;
  DOOREMI_CATEGORY_ID?: string;
  AUTOMATION_SECRET?: string;
  AUTOMATION_TRIGGER_ENABLED?: string;
  GOOGLE_NOTIFICATION_EMAIL?: string;
  SLOT_MONITOR_SECRET?: string;
};

export function getRuntimeEnv(): TennisRuntimeEnv {
  return env as unknown as TennisRuntimeEnv;
}

export function getDb() {
  const runtime = getRuntimeEnv();
  if (!runtime.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(runtime.DB, { schema });
}
