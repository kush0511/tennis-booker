import assert from "node:assert/strict";
import test from "node:test";

import historyFixture from "./fixtures/history.json" with { type: "json" };
import {
  AmbiguousSubmissionError,
  AuthenticationError,
  DOOREMI_IOS_USER_AGENT,
  DooremiClient,
  safeErrorMessage,
  type FetchLike,
} from "../lib/dooremi.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      date: "Fri, 03 Jul 2026 04:00:00 GMT",
    },
  });
}

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

test("a single booking call contains exactly one session and is never retried", async () => {
  const requests: RequestInit[] = [];
  const client = new DooremiClient({
    token: "hosted-secret-value",
    fetch: async (_input, init) => {
      requests.push(init ?? {});
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
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(String(requests[0].body)), {
    eventDay: "2026-07-17",
    bookingOrderFacilityList: [
      { facilityId: 9001, eventTime: "07:00-08:00" },
    ],
  });
});

test("unreadable create responses are explicitly ambiguous", async () => {
  const client = new DooremiClient({
    token: "hosted-secret-value",
    fetch: async () => new Response("not-json", { status: 200 }),
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
});
