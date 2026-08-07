const TOKEN_AAD = new TextEncoder().encode("court-signal:dooremi-token:v1");

export type EncryptedCredential = {
  ciphertext: string;
  iv: string;
  version: 1;
};

export class CredentialCryptoError extends Error {
  constructor() {
    super("The managed Dooremi session could not be decrypted.");
    this.name = "CredentialCryptoError";
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new CredentialCryptoError();
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  try {
    const binary = globalThis.atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new CredentialCryptoError();
  }
}

async function importEncryptionKey(encodedKey: string): Promise<CryptoKey> {
  const raw = decodeBase64Url(encodedKey);
  if (raw.byteLength !== 32) throw new CredentialCryptoError();
  try {
    return await globalThis.crypto.subtle.importKey(
      "raw",
      raw,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw new CredentialCryptoError();
  }
}

export async function encryptCredential(
  token: string,
  encodedKey: string,
): Promise<EncryptedCredential> {
  if (!token) throw new CredentialCryptoError();
  const key = await importEncryptionKey(encodedKey);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  try {
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: TOKEN_AAD },
      key,
      new TextEncoder().encode(token),
    );
    return {
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
      iv: encodeBase64Url(iv),
      version: 1,
    };
  } catch {
    throw new CredentialCryptoError();
  }
}

export async function decryptCredential(
  encrypted: EncryptedCredential,
  encodedKey: string,
): Promise<string> {
  if (encrypted.version !== 1) throw new CredentialCryptoError();
  const key = await importEncryptionKey(encodedKey);
  const iv = decodeBase64Url(encrypted.iv);
  const ciphertext = decodeBase64Url(encrypted.ciphertext);
  if (iv.byteLength !== 12) throw new CredentialCryptoError();
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: TOKEN_AAD },
      key,
      ciphertext,
    );
    const token = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (!token) throw new CredentialCryptoError();
    return token;
  } catch {
    throw new CredentialCryptoError();
  }
}
