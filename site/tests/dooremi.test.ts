import assert from "node:assert/strict";
import test from "node:test";

import historyFixture from "./fixtures/history.json" with { type: "json" };
import {
  AmbiguousSubmissionError,
  AuthenticationError,
  ClientUpgradeRequiredError,
  DOOREMI_IOS_USER_AGENT,
  DooremiClient,
  DooremiError,
  DooremiLoginRejectedError,
  loginDooremi,
  safeErrorMessage,
  type FetchLike,
} from "../lib/dooremi.js";

function tokenWithCreatedAt(createdAtSeconds: number): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ ct: createdAtSeconds })}.signature`;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      date: "Fri, 03 Jul 2026 04:00:00 GMT",
    },
  });
}

function bookingPreviewResponse(bookingFeeAmount: unknown = 0): Response {
  return jsonResponse({
    status: 0,
    msg: "ok",
    content: {
      bookingFeeAmount,
      hasPayNow: true,
      bookingOrderFacilityList: [
        {
          facilityName: "Tennis Court",
          eventDate: "2026-07-17",
          eventTime: "07:00-08:00",
        },
      ],
    },
  });
}

test("background sign-in uses the current app contract without authorization headers", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const token = tokenWithCreatedAt(Date.parse("2026-08-08T04:00:00Z") / 1_000);
  const result = await loginDooremi({
    userName: "12345678",
    password: "provider-password",
    fetch: async (input, init) => {
      requests.push({ url: new URL(String(input)), init });
      return jsonResponse({
        status: 0,
        content: { userId: 1, userName: "12345678", token, applyState: 1 },
      });
    },
  });

  assert.equal(result.token, token);
  assert.equal(result.issuedAt, "2026-08-08T04:00:00.000Z");
  assert.equal(requests[0].url.pathname, "/user/login");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    userName: "12345678",
    password: "provider-password",
  });
  const headers = new Headers(requests[0].init?.headers);
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("user-agent"), DOOREMI_IOS_USER_AGENT);
});

test("background sign-in rejections never echo login secrets", async () => {
  await assert.rejects(
    loginDooremi({
      userName: "12345678",
      password: "provider-password",
      fetch: async () =>
        jsonResponse({
          status: 1,
          msg: "Wrong password provider-password for 12345678",
        }),
    }),
    (error: unknown) =>
      error instanceof DooremiLoginRejectedError &&
      !error.message.includes("provider-password") &&
      !error.message.includes("12345678"),
  );
});

test("the server client sends the captured request shape without exposing its token", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const fetch: FetchLike = async (input, init) => {
    requests.push({ url: new URL(String(input)), init });
    return jsonResponse(historyFixture);
  };
  const client = new DooremiClient({
    token: "hosted-secret-value",
    fetch,
    monotonicNow: (() => {
      let value = 0;
      return () => (value += 5);
    })(),
  });

  const history = await client.bookingHistory({ pageSize: 50 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, "/user/booking/history");
  assert.equal(requests[0].url.searchParams.get("pageSize"), "50");
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(requests[0].init?.body, "{}");
  const headers = new Headers(requests[0].init?.headers);
  assert.equal(headers.get("authorization"), "Bearer hosted-secret-value");
  assert.equal(headers.get("user-agent"), DOOREMI_IOS_USER_AGENT);
  assert.equal(headers.get("connection"), null);
  assert.equal(Object.keys(client).some((key) => /token/i.test(key)), false);

  assert.deepEqual(
    history.map((booking) => ({
      id: booking.id,
      name: booking.facilityName,
      times: booking.eventTimes,
      canCancel: booking.canCancel,
    })),
    [
      {
        id: 501,
        name: "Tennis Court",
        times: ["07:00-08:00", "08:00-09:00"],
        canCancel: true,
      },
      {
        id: 502,
        name: "Function Room",
        times: ["18:00-19:00"],
        canCancel: false,
      },
    ],
  );
});

test("a booking mirrors the current app preview and management-payment flow", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const client = new DooremiClient({
    token: "hosted-secret-value",
    fetch: async (input, init) => {
      const request = { url: new URL(String(input)), init: init ?? {} };
      requests.push(request);
      if (request.url.pathname.endsWith("/orderPreview")) {
        return bookingPreviewResponse(2.5);
      }
      return jsonResponse({
        status: 0,
        msg: "ok",
        content: { message: "Confirmed", bookingOrderId: 901 },
      });
    },
  });
  const result = await client.createSingleBooking({
    eventDay: "2026-07-17",
    eventTimes: ["07:00-08:00"],
    facilityId: 9001,
  });
  assert.equal(result.bookingOrderId, 901);
  assert.equal(result.elapsedMs !== undefined, true);
  assert.deepEqual(
    requests.map((request) => request.url.pathname),
    ["/user/booking/orderPreview", "/user/booking/createOrderV2"],
  );
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    eventDay: "2026-07-17",
    bookingOrderFacilityList: [
      { facilityId: 9001, eventTime: "07:00-08:00" },
    ],
  });
  assert.deepEqual(JSON.parse(String(requests[1].init.body)), {
    eventDay: "2026-07-17",
    bookingOrderFacilityList: [
      { facilityId: 9001, eventTime: "07:00-08:00" },
    ],
    paymentType: "",
  });
});

test("a successful preview is cached and fee-free bookings omit paymentType", async () => {
  const paths: string[] = [];
  const bodies: unknown[] = [];
  const client = new DooremiClient({
    token: "hosted-secret-value",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      bodies.push(JSON.parse(String(init?.body)));
      return path.endsWith("/orderPreview")
        ? bookingPreviewResponse(0)
        : jsonResponse({
            status: 0,
            msg: "ok",
            content: { message: "Confirmed", bookingOrderId: 902 },
          });
    },
  });
  const schedule = {
    eventDay: "2026-07-17",
    eventTimes: ["07:00-08:00"],
    facilityId: 9001,
  };
  const first = await client.prepareSingleBooking(schedule);
  const second = await client.prepareSingleBooking(schedule);
  const result = await client.createSingleBooking(schedule);

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(result.bookingOrderId, 902);
  assert.deepEqual(paths, [
    "/user/booking/orderPreview",
    "/user/booking/createOrderV2",
  ]);
  assert.equal(Object.hasOwn(bodies[1] as object, "paymentType"), false);
});

test("unreadable create responses are explicitly ambiguous", async () => {
  let calls = 0;
  const client = new DooremiClient({
    token: "hosted-secret-value",
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? bookingPreviewResponse()
        : new Response("not-json", { status: 200 });
    },
  });
  await assert.rejects(
    client.createSingleBooking({
      eventDay: "2026-07-17",
      eventTimes: ["07:00-08:00"],
      facilityId: 9001,
    }),
    AmbiguousSubmissionError,
  );
});

test("server errors during submission are ambiguous and cannot be blindly retried", async () => {
  let calls = 0;
  const client = new DooremiClient({
    token: "hosted-secret-value",
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? bookingPreviewResponse()
        : jsonResponse({ status: 1, msg: "error" }, 503);
    },
  });
  await assert.rejects(
    client.createSingleBooking({
      eventDay: "2026-07-17",
      eventTimes: ["07:00-08:00"],
      facilityId: 9001,
    }),
    AmbiguousSubmissionError,
  );
});

test("a nonzero JSON status is an explicit rejection that can be retried safely", async () => {
  const client = new DooremiClient({
    token: "hosted-secret-value",
    fetch: async () =>
      jsonResponse({ status: 1, msg: "Unexpected error", content: null }),
  });
  await assert.rejects(
    client.createSingleBooking({
      eventDay: "2026-07-17",
      eventTimes: ["07:00-08:00"],
      facilityId: 9001,
    }),
    (error: unknown) =>
      error instanceof DooremiError &&
      error.code === "rejected" &&
      error.serverDate?.toISOString() === "2026-07-03T04:00:00.000Z" &&
      error.elapsedMs !== null,
  );
});

test("credential inspection identifies pre-migration tokens without exposing them", () => {
  const stale = new DooremiClient({
    token: tokenWithCreatedAt(Date.parse("2026-01-14T15:50:16Z") / 1_000),
  });
  const current = new DooremiClient({
    token: tokenWithCreatedAt(Date.parse("2026-08-07T04:00:00Z") / 1_000),
  });
  const opaque = new DooremiClient({ token: "opaque-secret" });

  assert.deepEqual(stale.bookingCredential(), {
    status: "upgrade_required",
    issuedAt: "2026-01-14T15:50:16.000Z",
    minimumIssuedAt: "2026-02-28T16:00:00.000Z",
  });
  assert.equal(current.bookingCredential().status, "current");
  assert.equal(opaque.bookingCredential().status, "unknown");
  assert.equal(Object.keys(stale).some((key) => /token/i.test(key)), false);
});

test("a stale credential is blocked before any booking request is transmitted", async () => {
  let requests = 0;
  const client = new DooremiClient({
    token: tokenWithCreatedAt(Date.parse("2026-01-14T15:50:16Z") / 1_000),
    fetch: async () => {
      requests += 1;
      return jsonResponse({ status: 0 });
    },
  });
  await assert.rejects(
    client.createSingleBooking({
      eventDay: "2026-08-21",
      eventTimes: ["07:00-08:00"],
      facilityId: 9001,
    }),
    (error: unknown) =>
      error instanceof ClientUpgradeRequiredError &&
      error.code === "client_upgrade_required" &&
      /No booking was changed/.test(error.message),
  );
  assert.equal(requests, 0);
});

test("the provider's latest-version rejection is terminal rather than retryable", async () => {
  const client = new DooremiClient({
    token: tokenWithCreatedAt(Date.parse("2026-08-07T04:00:00Z") / 1_000),
    fetch: async () =>
      jsonResponse({
        status: 1,
        msg: "Please update to the latest version to complete payment.",
      }),
  });
  await assert.rejects(
    client.createSingleBooking({
      eventDay: "2026-08-21",
      eventTimes: ["07:00-08:00"],
      facilityId: 9001,
    }),
    (error: unknown) =>
      error instanceof ClientUpgradeRequiredError &&
      error.code === "client_upgrade_required" &&
      error.elapsedMs !== null,
  );
});

test("authentication failures and sanitization never echo credentials", async () => {
  const client = new DooremiClient({
    token: "hosted-secret-value",
    fetch: async () => jsonResponse({}, 403),
  });
  await assert.rejects(client.warmup(), AuthenticationError);
  assert.equal(
    safeErrorMessage(new Error("failed with Bearer hosted-secret-value")),
    "failed with Bearer [redacted]",
  );
  assert.equal(
    safeErrorMessage("Please update to the latest version to complete payment."),
    "Please update to the latest version to complete payment.",
  );
});
