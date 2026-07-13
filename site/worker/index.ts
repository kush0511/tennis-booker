/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { AUTOMATION_HEARTBEAT_ID } from "../lib/automation";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AUTOMATION_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
  noRetry(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const imageResponse = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withSecurityHeaders(imageResponse);
    }

    return withSecurityHeaders(await handler.fetch(request, env, ctx));
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (!env.AUTOMATION_SECRET) return;
    const heartbeat = recordAutomationHeartbeat(controller, env);
    const request = new Request(
      "https://court-signal.internal/api/automation/run-due",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.AUTOMATION_SECRET}` },
      },
    );
    const runDue = worker.fetch(request, env, ctx).then(async (response) => {
      await response.arrayBuffer();
      if (!response.ok) {
        throw new Error(`Hosted automation failed (${response.status}).`);
      }
    });
    ctx.waitUntil(Promise.all([heartbeat, runDue]).then(() => undefined));
  },
};

async function recordAutomationHeartbeat(
  controller: ScheduledController,
  env: Env,
): Promise<void> {
  const now = new Date().toISOString();
  const scheduledAt = new Date(controller.scheduledTime).toISOString();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS automation_heartbeat (
      id TEXT PRIMARY KEY,
      last_seen_at TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      cron TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO automation_heartbeat (
      id, last_seen_at, scheduled_at, cron
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      scheduled_at = excluded.scheduled_at,
      cron = excluded.cron`)
      .bind(
        AUTOMATION_HEARTBEAT_ID,
        now,
        scheduledAt,
        controller.cron,
      ),
  ]);
}

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("Referrer-Policy", "no-referrer");
  secured.headers.set("X-Content-Type-Options", "nosniff");
  secured.headers.set("X-Frame-Options", "DENY");
  secured.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  return secured;
}

export default worker;
