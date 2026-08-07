import {
  DooremiClient,
  DooremiError,
  DooremiLoginRejectedError,
  loginDooremi,
  safeErrorMessage,
  type BookingCredentialInfo,
  type FetchLike,
} from "./dooremi.js";
import {
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
} from "./credential-crypto.js";

export const DOOREMI_SESSION_PROVIDER = "dooremi";
export const DOOREMI_BACKGROUND_REFRESH_MILLISECONDS = 12 * 60 * 60 * 1_000;
export const DOOREMI_VALIDATION_INTERVAL_MILLISECONDS = 30 * 60 * 1_000;
export const DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS = 5 * 60 * 1_000;
export const DOOREMI_REFRESH_BACKOFF_MILLISECONDS = Object.freeze([
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
]);

export type StoredProviderCredential = {
  provider: string;
  tokenCiphertext: string | null;
  tokenIv: string | null;
  encryptionVersion: number | null;
  issuedAt: string | null;
  refreshedAt: string | null;
  lastValidatedAt: string | null;
  lastRefreshAttemptAt: string | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  refreshLeaseUntil: string | null;
  loginIdentifierKind: "phone" | "email" | "other" | null;
  updatedAt: string;
};

export type ProviderCredentialSuccess = {
  tokenCiphertext: string;
  tokenIv: string;
  encryptionVersion: number;
  issuedAt: string | null;
  refreshedAt: string;
  lastValidatedAt: string;
  loginIdentifierKind: "phone" | "email" | "other";
};

export interface ProviderCredentialStore {
  read(provider: string): Promise<StoredProviderCredential | null>;
  claimRefresh(
    provider: string,
    nowIso: string,
    leaseUntilIso: string,
  ): Promise<boolean>;
  saveSuccess(provider: string, success: ProviderCredentialSuccess): Promise<void>;
  recordFailure(
    provider: string,
    attemptedAt: string,
    code: string,
    message: string,
  ): Promise<void>;
  recordValidation(provider: string, validatedAt: string): Promise<void>;
}

export type DooremiSessionConfig = {
  userName?: string;
  fallbackUserName?: string;
  password?: string;
  encryptionKey?: string;
  bootstrapToken?: string;
};

export type DooremiSessionStatus = {
  autoRenewConfigured: boolean;
  source: "managed" | "bootstrap" | "missing" | "error";
  bookingCredential: BookingCredentialInfo | {
    status: "missing";
    issuedAt: null;
    minimumIssuedAt: null;
  };
  refreshedAt: string | null;
  lastValidatedAt: string | null;
  lastRefreshAttemptAt: string | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  loginIdentifierKind: "phone" | "email" | "other" | null;
  needsAttention: boolean;
};

export type DooremiClientRequest = {
  freshWithinMilliseconds?: number;
  requireManagedRefresh?: boolean;
  forceRefresh?: boolean;
};

type SessionManagerOptions = {
  config: DooremiSessionConfig;
  store: ProviderCredentialStore;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
};

type ManagedSessionMaterial = {
  token: string;
  cookieHeader: string | null;
  mobileInitializationAttempted: boolean;
};

function serializeManagedSession(material: ManagedSessionMaterial): string {
  return JSON.stringify({
    version: 1,
    token: material.token,
    cookieHeader: material.cookieHeader,
    mobileInitializationAttempted: material.mobileInitializationAttempted,
  });
}

function parseManagedSession(plaintext: string): ManagedSessionMaterial {
  try {
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    const cookieHeader =
      parsed.cookieHeader === null || parsed.cookieHeader === undefined
        ? null
        : typeof parsed.cookieHeader === "string" &&
            parsed.cookieHeader.length <= 8_192 &&
            !/[\u0000-\u001f\u007f]/.test(parsed.cookieHeader)
          ? parsed.cookieHeader
          : undefined;
    if (
      parsed.version === 1 &&
      typeof parsed.token === "string" &&
      parsed.token &&
      cookieHeader !== undefined
    ) {
      return {
        token: parsed.token,
        cookieHeader,
        mobileInitializationAttempted:
          parsed.mobileInitializationAttempted === true,
      };
    }
  } catch {
    // Existing deployments encrypted the raw token directly.
  }
  return {
    token: plaintext,
    cookieHeader: null,
    mobileInitializationAttempted: false,
  };
}

export class ManagedCredentialUnavailableError extends DooremiError {
  constructor(message = "The app-managed Dooremi session is unavailable.") {
    super(message, "authentication");
    this.name = "ManagedCredentialUnavailableError";
  }
}

export class DooremiSessionManager {
  readonly #config: DooremiSessionConfig;
  readonly #store: ProviderCredentialStore;
  readonly #fetch?: FetchLike;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: SessionManagerOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#fetch = options.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  }

  autoRenewConfigured(): boolean {
    return Boolean(
      this.#config.userName?.trim() &&
        this.#config.password &&
        this.#config.encryptionKey,
    );
  }

  async client(request: DooremiClientRequest = {}): Promise<DooremiClient> {
    const material = await this.#session(request);
    return new DooremiClient({
      token: material.token,
      cookieHeader: material.cookieHeader,
      fetch: this.#fetch,
    });
  }

  async maintain(): Promise<DooremiSessionStatus> {
    let record = await this.#store.read(DOOREMI_SESSION_PROVIDER);
    if (this.#refreshBackoffActive(record)) return this.status();
    let client: DooremiClient;
    try {
      client = await this.client({
        freshWithinMilliseconds: DOOREMI_BACKGROUND_REFRESH_MILLISECONDS,
      });
    } catch {
      return this.status();
    }

    record = await this.#store.read(DOOREMI_SESSION_PROVIDER);

    const validatedAt = record?.lastValidatedAt
      ? Date.parse(record.lastValidatedAt)
      : Number.NaN;
    if (
      Number.isFinite(validatedAt) &&
      this.#now().valueOf() - validatedAt <
        DOOREMI_VALIDATION_INTERVAL_MILLISECONDS
    ) {
      return this.status();
    }

    try {
      await client.warmup();
      await this.#store.recordValidation(
        DOOREMI_SESSION_PROVIDER,
        this.#now().toISOString(),
      );
    } catch (error) {
      if (
        error instanceof DooremiError &&
        error.code === "authentication" &&
        this.autoRenewConfigured()
      ) {
        await this.client({ forceRefresh: true });
      } else {
        await this.#recordFailure(error);
      }
    }
    return this.status();
  }

  async status(): Promise<DooremiSessionStatus> {
    const record = await this.#store.read(DOOREMI_SESSION_PROVIDER);
    let source: DooremiSessionStatus["source"] = "missing";
    let bookingCredential: DooremiSessionStatus["bookingCredential"] = {
      status: "missing",
      issuedAt: null,
      minimumIssuedAt: null,
    };

    if (
      record?.tokenCiphertext &&
      record.tokenIv &&
      record.encryptionVersion === 1 &&
      this.#config.encryptionKey
    ) {
      try {
        const plaintext = await decryptCredential(
          {
            ciphertext: record.tokenCiphertext,
            iv: record.tokenIv,
            version: 1,
          },
          this.#config.encryptionKey,
        );
        const material = parseManagedSession(plaintext);
        bookingCredential = new DooremiClient({
          token: material.token,
          cookieHeader: material.cookieHeader,
        }).bookingCredential();
        source = "managed";
      } catch {
        source = "error";
      }
    } else if (this.#config.bootstrapToken) {
      bookingCredential = new DooremiClient({
        token: this.#config.bootstrapToken,
      }).bookingCredential();
      source = "bootstrap";
    }

    const failures = record?.consecutiveFailures ?? 0;
    return {
      autoRenewConfigured: this.autoRenewConfigured(),
      source,
      bookingCredential,
      refreshedAt: record?.refreshedAt ?? null,
      lastValidatedAt: record?.lastValidatedAt ?? null,
      lastRefreshAttemptAt: record?.lastRefreshAttemptAt ?? null,
      consecutiveFailures: failures,
      lastErrorCode: record?.lastErrorCode ?? null,
      lastErrorMessage: record?.lastErrorMessage ?? null,
      loginIdentifierKind: record?.loginIdentifierKind ?? null,
      needsAttention:
        source === "error" ||
        bookingCredential.status === "missing" ||
        bookingCredential.status === "upgrade_required" ||
        (!this.autoRenewConfigured() && source !== "managed") ||
        failures >= 2,
    };
  }

  async #session(
    request: DooremiClientRequest,
  ): Promise<ManagedSessionMaterial> {
    const freshness =
      request.freshWithinMilliseconds ??
      DOOREMI_BACKGROUND_REFRESH_MILLISECONDS;
    const record = await this.#store.read(DOOREMI_SESSION_PROVIDER);
    const managedSession = await this.#usableManagedSession(
      record,
      request.forceRefresh ? -1 : freshness,
    );
    if (
      managedSession &&
      (!request.requireManagedRefresh ||
        managedSession.mobileInitializationAttempted)
    ) {
      return managedSession;
    }

    if (this.autoRenewConfigured()) {
      if (
        !request.forceRefresh &&
        !request.requireManagedRefresh &&
        this.#refreshBackoffActive(record)
      ) {
        const staleManagedSession = await this.#usableManagedSession(
          record,
          Number.POSITIVE_INFINITY,
        );
        if (staleManagedSession) return staleManagedSession;
        if (this.#config.bootstrapToken) {
          return {
            token: this.#config.bootstrapToken,
            cookieHeader: null,
            mobileInitializationAttempted: false,
          };
        }
        throw new ManagedCredentialUnavailableError(
          "Background Dooremi sign-in is waiting before its next retry.",
        );
      }
      try {
        return await this.#refresh(record);
      } catch (error) {
        if (request.requireManagedRefresh) throw error;
        const staleManagedSession = await this.#usableManagedSession(
          record,
          Number.POSITIVE_INFINITY,
        );
        if (staleManagedSession) return staleManagedSession;
        if (this.#config.bootstrapToken) {
          return {
            token: this.#config.bootstrapToken,
            cookieHeader: null,
            mobileInitializationAttempted: false,
          };
        }
        throw error;
      }
    }

    if (request.requireManagedRefresh) {
      throw new ManagedCredentialUnavailableError(
        "Background Dooremi sign-in is not configured. No booking was changed.",
      );
    }
    if (managedSession) return managedSession;
    if (this.#config.bootstrapToken) {
      return {
        token: this.#config.bootstrapToken,
        cookieHeader: null,
        mobileInitializationAttempted: false,
      };
    }
    throw new ManagedCredentialUnavailableError();
  }

  #refreshBackoffActive(record: StoredProviderCredential | null): boolean {
    if (!record?.lastRefreshAttemptAt || record.consecutiveFailures < 1) {
      return false;
    }
    const attemptedAt = Date.parse(record.lastRefreshAttemptAt);
    if (!Number.isFinite(attemptedAt)) return false;
    const index = Math.min(
      record.consecutiveFailures - 1,
      DOOREMI_REFRESH_BACKOFF_MILLISECONDS.length - 1,
    );
    return (
      this.#now().valueOf() - attemptedAt <
      DOOREMI_REFRESH_BACKOFF_MILLISECONDS[index]
    );
  }

  async #usableManagedSession(
    record: StoredProviderCredential | null,
    freshnessMilliseconds: number,
  ): Promise<ManagedSessionMaterial | null> {
    if (
      !record?.tokenCiphertext ||
      !record.tokenIv ||
      record.encryptionVersion !== 1 ||
      !record.refreshedAt ||
      !this.#config.encryptionKey
    ) {
      return null;
    }
    const refreshedAt = Date.parse(record.refreshedAt);
    if (
      !Number.isFinite(refreshedAt) ||
      this.#now().valueOf() - refreshedAt > freshnessMilliseconds
    ) {
      return null;
    }
    try {
      const plaintext = await decryptCredential(
        {
          ciphertext: record.tokenCiphertext,
          iv: record.tokenIv,
          version: 1,
        },
        this.#config.encryptionKey,
      );
      return parseManagedSession(plaintext);
    } catch (error) {
      if (error instanceof CredentialCryptoError) return null;
      throw error;
    }
  }

  async #refresh(
    baseline: StoredProviderCredential | null,
  ): Promise<ManagedSessionMaterial> {
    const now = this.#now();
    const leaseUntil = new Date(now.valueOf() + 20_000);
    let claimed = await this.#store.claimRefresh(
      DOOREMI_SESSION_PROVIDER,
      now.toISOString(),
      leaseUntil.toISOString(),
    );

    if (!claimed) {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        await this.#sleep(250);
        const concurrent = await this.#store.read(DOOREMI_SESSION_PROVIDER);
        if (
          concurrent?.refreshedAt &&
          concurrent.refreshedAt !== baseline?.refreshedAt
        ) {
          const material = await this.#usableManagedSession(
            concurrent,
            DOOREMI_PREBOOKING_FRESHNESS_MILLISECONDS,
          );
          if (material?.mobileInitializationAttempted) return material;
        }
        if (!concurrent?.refreshLeaseUntil) break;
      }
      const retryAt = this.#now();
      claimed = await this.#store.claimRefresh(
        DOOREMI_SESSION_PROVIDER,
        retryAt.toISOString(),
        new Date(retryAt.valueOf() + 20_000).toISOString(),
      );
    }

    if (!claimed) {
      throw new ManagedCredentialUnavailableError(
        "A background Dooremi sign-in is already in progress. No booking was changed.",
      );
    }

    try {
      const { token, userName, sessionCookieHeader } = await this.#login();
      let cookieHeader = sessionCookieHeader;
      const client = new DooremiClient({
        token,
        cookieHeader,
        fetch: this.#fetch,
        onCookieHeaderChange: (value) => {
          cookieHeader = value;
        },
      });
      client.assertBookingCredentialCurrent();
      await client.warmup();
      try {
        await client.initializeMobileSession();
      } catch (error) {
        if (error instanceof DooremiError && error.code === "authentication") {
          throw error;
        }
        // The current app treats SIP initialization as best-effort too. The
        // important compatibility property is that the request was attempted.
      }
      const material: ManagedSessionMaterial = {
        token,
        cookieHeader,
        mobileInitializationAttempted: true,
      };
      const encrypted = await encryptCredential(
        serializeManagedSession(material),
        this.#config.encryptionKey!,
      );
      const refreshedAt = this.#now().toISOString();
      await this.#store.saveSuccess(DOOREMI_SESSION_PROVIDER, {
        tokenCiphertext: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        encryptionVersion: encrypted.version,
        issuedAt: client.bookingCredential().issuedAt,
        refreshedAt,
        lastValidatedAt: refreshedAt,
        loginIdentifierKind: identifierKind(userName),
      });
      return material;
    } catch (error) {
      await this.#recordFailure(error);
      throw error;
    }
  }

  async #login(): Promise<{
    token: string;
    userName: string;
    sessionCookieHeader: string | null;
  }> {
    const primary = this.#config.userName!.trim();
    try {
      const result = await loginDooremi({
        userName: primary,
        password: this.#config.password!,
        fetch: this.#fetch,
      });
      return {
        token: result.token,
        userName: primary,
        sessionCookieHeader: result.sessionCookieHeader,
      };
    } catch (error) {
      const fallback = this.#config.fallbackUserName?.trim();
      if (!(error instanceof DooremiLoginRejectedError) || !fallback) {
        throw error;
      }
      const result = await loginDooremi({
        userName: fallback,
        password: this.#config.password!,
        fetch: this.#fetch,
      });
      return {
        token: result.token,
        userName: fallback,
        sessionCookieHeader: result.sessionCookieHeader,
      };
    }
  }

  async #recordFailure(error: unknown): Promise<void> {
    const code =
      error instanceof DooremiError
        ? error.code
        : error instanceof CredentialCryptoError
          ? "decrypt_failed"
          : "refresh_failed";
    const message = safeErrorMessage(error) || "Background sign-in failed.";
    await this.#store.recordFailure(
      DOOREMI_SESSION_PROVIDER,
      this.#now().toISOString(),
      code,
      message,
    );
  }
}

function identifierKind(
  userName: string,
): "phone" | "email" | "other" {
  if (/^\d{8}$/.test(userName)) return "phone";
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(userName)) return "email";
  return "other";
}
