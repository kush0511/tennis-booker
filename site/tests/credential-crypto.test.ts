import assert from "node:assert/strict";
import test from "node:test";

import {
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
} from "../lib/credential-crypto.js";

const encryptionKey = Buffer.alloc(32, 17).toString("base64url");

test("managed provider tokens round-trip through authenticated encryption", async () => {
  const token = "header.current-provider-token.signature";
  const encrypted = await encryptCredential(token, encryptionKey);

  assert.equal(encrypted.version, 1);
  assert.notEqual(encrypted.ciphertext, token);
  assert.equal(encrypted.iv.length > 0, true);
  assert.equal(await decryptCredential(encrypted, encryptionKey), token);
});

test("managed provider token tampering is rejected without exposing plaintext", async () => {
  const token = "header.current-provider-token.signature";
  const encrypted = await encryptCredential(token, encryptionKey);
  const first = encrypted.ciphertext[0] === "A" ? "B" : "A";

  await assert.rejects(
    decryptCredential(
      { ...encrypted, ciphertext: first + encrypted.ciphertext.slice(1) },
      encryptionKey,
    ),
    (error: unknown) =>
      error instanceof CredentialCryptoError && !error.message.includes(token),
  );
});

test("managed provider encryption rejects malformed keys", async () => {
  await assert.rejects(
    encryptCredential("secret-token", "not-a-32-byte-key"),
    CredentialCryptoError,
  );
});
