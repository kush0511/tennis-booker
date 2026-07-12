import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the protected Court Signal entry", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");

  const html = await response.text();
  assert.match(html, /<title>Court Signal<\/title>/i);
  assert.match(html, /Your booking window, under control/i);
  assert.match(html, /Sign in with ChatGPT/i);
  assert.match(html, /never sends the Dooremi token to your browser/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|taking shape/i);
});

test("removes all starter preview infrastructure", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /codex-preview|SkeletonPreview/);
  assert.match(layout, /Court Signal/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("ships mobile viewport and server-only token boundaries", async () => {
  const [layout, page, dashboard, api] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/tennis-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/_server/api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /width:\s*"device-width"/);
  assert.match(layout, /viewportFit:\s*"cover"/);
  assert.match(dashboard, /mobile-nav/);
  assert.doesNotMatch(dashboard, /DOOREMI_BEARER_TOKEN\s*[=:]/);
  assert.match(api, /getRuntimeEnv\(\)\.DOOREMI_BEARER_TOKEN/);
  assert.doesNotMatch(page, /Date\.now\(\)/);
  assert.match(dashboard, /useState<number \| null>\(null\)/);
  assert.doesNotMatch(dashboard, /useState\(\(\) => Date\.now\(\)\)/);
});

test("packages the unattended runner and protected heartbeat status", async () => {
  const [wranglerConfig, worker, statusRoute] = await Promise.all([
    readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/automation/status/route.ts", import.meta.url),
      "utf8",
    ),
  ]);
  const config = JSON.parse(wranglerConfig);
  assert.deepEqual(config.triggers?.crons, ["* * * * *"]);
  assert.match(worker, /async scheduled\(/);
  assert.match(worker, /recordAutomationHeartbeat/);
  assert.match(statusRoute, /Automation authorization failed/);
});
