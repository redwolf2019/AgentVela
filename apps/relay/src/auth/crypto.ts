// @effect-diagnostics nodeBuiltinImport:off -- Relay authentication cryptography uses Node built-in crypto primitives.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class RelayCryptoError extends Schema.TaggedError<
  RelayCryptoError,
  { readonly brand: unique symbol }
>()("RelayCryptoError", {
  message: Schema.String,
}) {
  override get name(): string {
    return "RelayCryptoError";
  }
}

export const MIN_RELAY_PASSWORD_LENGTH = 12;

const DISALLOWED_PLACEHOLDER_PASSWORDS = new Set([
  "change-me-to-a-long-secret",
  "changeme",
  "password1234",
  "administrator",
]);

const SCRYPT_KEY_BYTES = 64;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } as const;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function isAcceptableRelayPassword(password: string): boolean {
  if (password.length < MIN_RELAY_PASSWORD_LENGTH) {
    return false;
  }
  return !DISALLOWED_PLACEHOLDER_PASSWORDS.has(password.trim().toLowerCase());
}

export function hashOpaqueToken(token: string): string {
  return NodeCrypto.createHash("sha256").update(token, "utf8").digest("base64url");
}

export function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  return NodeCrypto.timingSafeEqual(leftBytes, rightBytes);
}

export function generateRandomToken(prefix = "", byteLength = 32): string {
  const token = NodeCrypto.randomBytes(byteLength).toString("base64url");
  return prefix.length > 0 ? `${prefix}${token}` : token;
}

export function generateDeviceUserCode(): string {
  const bytes = NodeCrypto.randomBytes(8);
  let raw = "";
  for (let index = 0; index < 8; index++) {
    const byte = bytes[index] ?? 0;
    raw += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function generateRelayEndpointKey(): string {
  return `env-${NodeCrypto.randomBytes(8).toString("hex")}`;
}

export function generateEd25519PemKeypair(): {
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
} {
  const pair = NodeCrypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    publicKeyPem: pair.publicKey,
    privateKeyPem: pair.privateKey,
  };
}

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    NodeCrypto.scrypt(password, salt, SCRYPT_KEY_BYTES, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

export const hashPassword = Effect.fn("AuthCrypto.hashPassword")(function* (password: string) {
  const salt = NodeCrypto.randomBytes(16);
  const derived = yield* Effect.tryPromise({
    try: () => scryptAsync(password, salt),
    catch: (cause) => new RelayCryptoError({ message: `scrypt hash failed: ${String(cause)}` }),
  });
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
});

export const verifyPassword = Effect.fn("AuthCrypto.verifyPassword")(function* (
  password: string,
  encodedHash: string,
) {
  const parts = encodedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const saltText = parts[1];
  const digestText = parts[2];
  if (!saltText || !digestText) {
    return false;
  }
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(digestText, "base64url");
  if (salt.byteLength === 0 || expected.byteLength !== SCRYPT_KEY_BYTES) {
    return false;
  }
  const actual = yield* Effect.tryPromise({
    try: () => scryptAsync(password, salt),
    catch: (cause) => new RelayCryptoError({ message: `scrypt verify failed: ${String(cause)}` }),
  });
  return actual.byteLength === expected.byteLength && NodeCrypto.timingSafeEqual(actual, expected);
});
