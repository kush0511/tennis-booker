import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectivityError,
  type FetchLike,
} from "../lib/dooremi.js";
import {
  DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS,
  DOOREMI_SESSION_PROVIDER,
  DooremiSessionManager,
  type ProviderCredentialStore,
  type ProviderCredentialSuccess,
  type StoredProviderCredential,
} from "../lib/dooremi-session.js";

const encryptionKey = Buffer.alloc(32, 23).toString("base64url");

function tokenWithCreatedAt(createdAtSeconds: number): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ ct: createdAtSeconds })}.signature`;
}

function providerResponse(
  payload: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

class MemoryCredentialStore implements ProviderCredentialStore {
  record: StoredProviderCredential | null = null;

  async read(): Promise<StoredProviderCredential | null> {
    return this.record ? { ...this.record } : null;
  }

  async claimRefresh(
    provider: string,
    nowIso: string,
    leaseUntilIso: string,
  ): Promise<boolean> {
    if (
      this.record?.refreshLeaseUntil &&
      Date.parse(this.record.refreshLeaseUntil) >= Date.parse(nowIso)
    ) {
      return false;
    }
    this.record = {
      provider,
      tokenCiphertext: this.record?.tokenCiphertext ?? null,
      tokenIv: this.record?.tokenIv ?? null,
      encryptionVersion: this.record?.encryptionVersion ?? null,
      issuedAt: this.record?.issuedAt ?? null,
      refreshedAt: this.record?.refreshedAt ?? null,
      lastValidatedAt: this.record?.lastValidatedAt ?? null,
      lastRefreshAttemptAt: nowIso,
      consecutiveFailures: this.record?.consecutiveFailures ?? 0,
      lastErrorCode: this.record?.lastErrorCode ?? null,
      lastErrorMessage: this.record?.lastErrorMessage ?? null,
      refreshLeaseUntil: leaseUntilIso,
      loginIdentifierKind: this.record?.loginIdentifierKind ?? null,
      updatedAt: nowIso,
    };
    return true;
  }

  async saveSuccess(
    provider: string,
    success: ProviderCredentialSuccess,
  ): Promise<void> {
    this.record = {
      provider,
      ...success,
      consecutiveFailures: 0,
      lastRefreshAttemptAt: success.refreshedAt,
      lastErrorCode: null,
      lastErrorMessage: null,
      refreshLeaseUntil: null,
      updatedAt: success.refreshedAt,
    };
  }

  async recordFailure(
    provider: string,
    attemptedAt: string,
    code: string,
    message: string,
  ): Promise<void> {
    this.record = {
      provider,
      tokenCiphertext: this.record?.tokenCiphertext ?? null,
      tokenIv: this.record?.tokenIv ?? null,
      encryptionVersion: this.record?.encryptionVersion ?? null,
      issuedAt: this.record?.issuedAt ?? null,
      refreshedAt: this.record?.refreshedAt ?? null,
      lastValidatedAt: this.record?.lastValidatedAt ?? null,
      lastRefreshAttemptAt: attemptedAt,
      consecutiveFailures: (this.record?.consecutiveFailures ?? 0) + 1,
      lastErrorCode: code,
      lastErrorMessage: message,
      refreshLeaseUntil: null,
      loginIdentifierKind: this.record?.loginIdentifierKind ?? null,
      updatedAt: attemptedAt,
    };
  }

  async recordValidation(provider: string, validatedAt: string): Promise<void> {
    if (!this.record) return;
    this.record = {
      ...this.record,
      provider,
      lastValidatedAt: validatedAt,
      consecutiveFailures: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: validatedAt,
    };
  }
}

test("the manager signs in with phone first and persists only ciphertext", async () => {
  const store = new MemoryCredentialStore();
  const token = tokenWithCreatedAt(Date.parse("2026-08-08T04:00:00Z") / 1_000);
  const requests: Array<{ path: string; cookie: string | null }> = [];
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({
      path,
      cookie: new Headers(init?.headers).get("cookie"),
    });
    if (path === "/user/login") {
      return providerResponse(
        { status: 0, content: { token } },
        { "set-cookie": "dooremi_session=login-cookie; Path=/; HttpOnly" },
      );
    }
    return path === "/user/checkLogin"
      ? providerResponse(
          { status: 0, content: {} },
          { "set-cookie": "dooremi_session=mobile-cookie; Path=/; HttpOnly" },
        )
      : providerResponse({ status: 0, content: {} });
  };
  const manager = new DooremiSessionManager({
    config: {
      userName: "12345678",
      fallbackUserName: "player@example.com",
      password: "provider-password",
      encryptionKey,
    },
    store,
    fetch,
    now: () => new Date("2026-08-08T04:01:00Z"),
  });

  const client = await manager.client({
    freshWithinMilliseconds: DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS,
    requireManagedRefresh: true,
  });
  assert.equal(client.bookingCredential().status, "current");
  assert.deepEqual(
    requests.map((request) => request.path),
    ["/user/login", "/user/checkLogin", "/user/gvs/getSipInfoV2"],
  );
  assert.equal(requests[0].cookie, null);
  assert.equal(requests[1].cookie, "dooremi_session=login-cookie");
  assert.equal(requests[2].cookie, "dooremi_session=mobile-cookie");
  assert.equal(client.sessionCookieCount(), 1);
  assert.equal(store.record?.provider, DOOREMI_SESSION_PROVIDER);
  assert.equal(store.record?.loginIdentifierKind, "phone");
  assert.equal(store.record?.consecutiveFailures, 0);
  assert.notEqual(store.record?.tokenCiphertext, token);
  assert.equal(JSON.stringify(store.record).includes(token), false);
  assert.equal(JSON.stringify(store.record).includes("provider-password"), false);
});

test("the manager falls back to email only after an explicit phone rejection", async () => {
  const store = new MemoryCredentialStore();
  const token = tokenWithCreatedAt(Date.parse("2026-08-08T04:00:00Z") / 1_000);
  const loginNames: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path !== "/user/login") return providerResponse({ status: 0 });
    const body = JSON.parse(String(init?.body)) as { userName: string };
    loginNames.push(body.userName);
    return body.userName === "12345678"
      ? providerResponse({ status: 1, msg: "login failed" })
      : providerResponse({ status: 0, content: { token } });
  };
  const manager = new DooremiSessionManager({
    config: {
      userName: "12345678",
      fallbackUserName: "player@example.com",
      password: "provider-password",
      encryptionKey,
    },
    store,
    fetch,
    now: () => new Date("2026-08-08T04:01:00Z"),
  });

  await manager.client({ forceRefresh: true, requireManagedRefresh: true });
  assert.deepEqual(loginNames, ["12345678", "player@example.com"]);
  assert.equal(store.record?.loginIdentifierKind, "email");
});

test("connectivity failures do not trigger the fallback identity", async () => {
  const store = new MemoryCredentialStore();
  let requests = 0;
  const manager = new DooremiSessionManager({
    config: {
      userName: "12345678",
      fallbackUserName: "player@example.com",
      password: "provider-password",
      encryptionKey,
    },
    store,
    fetch: async () => {
      requests += 1;
      throw new Error("offline");
    },
    now: () => new Date("2026-08-08T04:01:00Z"),
  });

  await assert.rejects(
    manager.client({ forceRefresh: true, requireManagedRefresh: true }),
    ConnectivityError,
  );
  await manager.maintain();
  assert.equal(requests, 1);
  assert.equal(store.record?.consecutiveFailures, 1);
  assert.equal(store.record?.lastErrorCode, "connectivity");
  assert.equal(JSON.stringify(store.record).includes("player@example.com"), false);
});

test("a fresh managed session is reused inside the pre-booking window", async () => {
  const store = new MemoryCredentialStore();
  const token = tokenWithCreatedAt(Date.parse("2026-08-08T04:00:00Z") / 1_000);
  let loginRequests = 0;
  let now = new Date("2026-08-08T04:01:00Z");
  const fetch: FetchLike = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/user/login") loginRequests += 1;
    return path === "/user/login"
      ? providerResponse({ status: 0, content: { token } })
      : providerResponse({ status: 0 });
  };
  const manager = new DooremiSessionManager({
    config: {
      userName: "12345678",
      password: "provider-password",
      encryptionKey,
    },
    store,
    fetch,
    now: () => now,
  });

  await manager.client({
    freshWithinMilliseconds: DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS,
    requireManagedRefresh: true,
  });
  now = new Date("2026-08-08T04:04:00Z");
  await manager.client({
    freshWithinMilliseconds: DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS,
    requireManagedRefresh: true,
  });
  assert.equal(loginRequests, 1);
});
