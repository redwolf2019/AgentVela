// @effect-diagnostics nodeBuiltinImport:off -- Validates Ed25519 SPKI PEM keys synchronously via node:crypto.
import * as NodeCrypto from "node:crypto";

import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  AgentVelaRelayEndpoint,
  RelayUserId,
  RelayUserRole,
  RelayUsername,
} from "@t3tools/contracts/agentVelaRelay";
import { normalizeRelayIssuer } from "@t3tools/shared/relayJwt";
import { normalizeRelayUrl } from "@t3tools/shared/relayUrl";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_LINK_REVOKED,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";

const SELF_HOSTED_RELAY_LINK_SECRET = "agent-vela-relay-link-config";
const SELF_HOSTED_RELAY_CLI_SESSION_SECRET = "agent-vela-relay-cli-session";

export const StoredSelfHostedRelayLink = Schema.Struct({
  relayUrl: TrimmedNonEmptyString,
  relayIssuer: TrimmedNonEmptyString,
  userId: RelayUserId,
  endpoint: AgentVelaRelayEndpoint,
  environmentCredential: TrimmedNonEmptyString,
  relayMintPublicKey: TrimmedNonEmptyString,
  linkedAt: IsoDateTime,
});
export type StoredSelfHostedRelayLink = typeof StoredSelfHostedRelayLink.Type;

export const StoredRelayCliSession = Schema.Struct({
  relayUrl: TrimmedNonEmptyString,
  userId: RelayUserId,
  username: RelayUsername,
  role: RelayUserRole,
  accessToken: TrimmedNonEmptyString,
  accessTokenExpiresAt: IsoDateTime,
  refreshToken: TrimmedNonEmptyString,
  refreshTokenExpiresAt: IsoDateTime,
});
export type StoredRelayCliSession = typeof StoredRelayCliSession.Type;

const StoredLinkJson = Schema.fromJsonString(StoredSelfHostedRelayLink);
const decodeStoredLink = Schema.decodeUnknownOption(StoredLinkJson);
const encodeStoredLink = Schema.encodeEffect(StoredLinkJson);

const StoredCliSessionJson = Schema.fromJsonString(StoredRelayCliSession);
const decodeStoredCliSession = Schema.decodeUnknownOption(StoredCliSessionJson);
const encodeStoredCliSession = Schema.encodeEffect(StoredCliSessionJson);

export class RelayStateValidationError extends Schema.TaggedError<RelayStateValidationError>()(
  "RelayStateValidationError",
  {
    field: Schema.Literals(["relayUrl", "relayMintPublicKey", "endpoint"]),
    message: Schema.String,
  },
) {}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function stringToBytes(value: string): Uint8Array {
  return utf8Encoder.encode(value);
}

function bytesToString(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

function normalizeRelayMintPublicKeyPem(pem: string): string | null {
  const normalized = pem.replace(/\\n/gu, "\n").trim();
  if (normalized.length === 0) return null;
  try {
    const key = NodeCrypto.createPublicKey({ key: normalized, format: "pem", type: "spki" });
    return key.asymmetricKeyType === "ed25519" ? normalized : null;
  } catch {
    return null;
  }
}

export const readRelayLinkConfig = Effect.fn("relayState.readLinkConfig")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const raw = yield* secrets.get(SELF_HOSTED_RELAY_LINK_SECRET);
  if (Option.isNone(raw)) return Option.none<StoredSelfHostedRelayLink>();
  return decodeStoredLink(bytesToString(raw.value));
});

export interface SaveRelayLinkInput {
  readonly relayUrl: string;
  readonly relayIssuer: string;
  readonly userId: RelayUserId;
  readonly endpoint: AgentVelaRelayEndpoint;
  readonly environmentCredential: string;
  readonly relayMintPublicKey: string;
  readonly linkedAt?: IsoDateTime;
}

export const saveRelayLinkConfig = Effect.fn("relayState.saveLinkConfig")(function* (
  input: SaveRelayLinkInput,
) {
  const normalizedUrl = normalizeRelayUrl(input.relayUrl);
  if (normalizedUrl === null) {
    return yield* new RelayStateValidationError({
      field: "relayUrl",
      message: "Relay URL must use https://, or http:// on loopback, RFC1918 LAN, or Tailscale.",
    });
  }
  const normalizedMintKey = normalizeRelayMintPublicKeyPem(input.relayMintPublicKey);
  if (normalizedMintKey === null) {
    return yield* new RelayStateValidationError({
      field: "relayMintPublicKey",
      message: "Relay mint public key must be a valid Ed25519 SPKI PEM key.",
    });
  }
  const now = yield* DateTime.now;
  const linkedAt = input.linkedAt ?? IsoDateTime.make(DateTime.formatIso(now));
  const record: StoredSelfHostedRelayLink = {
    relayUrl: TrimmedNonEmptyString.make(normalizedUrl),
    relayIssuer: TrimmedNonEmptyString.make(
      normalizeRelayIssuer(input.relayIssuer || normalizedUrl),
    ),
    userId: input.userId,
    endpoint: input.endpoint,
    environmentCredential: TrimmedNonEmptyString.make(input.environmentCredential.trim()),
    relayMintPublicKey: TrimmedNonEmptyString.make(normalizedMintKey),
    linkedAt,
  };
  const encoded = yield* encodeStoredLink(record);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.set(SELF_HOSTED_RELAY_LINK_SECRET, stringToBytes(encoded));
  // Sync keys used by RelayBrokerService and RelayDeliveryProof.
  yield* Effect.all(
    [
      secrets.set(CLOUD_MINT_PUBLIC_KEY, stringToBytes(normalizedMintKey)),
      secrets.set(RELAY_ISSUER_SECRET, stringToBytes(record.relayIssuer)),
      secrets.set(RELAY_URL_SECRET, stringToBytes(record.relayUrl)),
      secrets.set(CLOUD_LINKED_USER_ID, stringToBytes(record.userId)),
      secrets.remove(CLOUD_LINK_REVOKED),
    ],
    { concurrency: 5 },
  );
  return record;
});

export const clearRelayLinkConfig = Effect.fn("relayState.clearLinkConfig")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.remove(SELF_HOSTED_RELAY_LINK_SECRET);
  yield* Effect.all(
    [
      secrets.remove(CLOUD_MINT_PUBLIC_KEY),
      secrets.remove(RELAY_ISSUER_SECRET),
      secrets.remove(RELAY_URL_SECRET),
      secrets.remove(CLOUD_LINKED_USER_ID),
    ],
    { concurrency: 4 },
  );
});

export const readRelayCliSession = Effect.fn("relayState.readCliSession")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const raw = yield* secrets.get(SELF_HOSTED_RELAY_CLI_SESSION_SECRET);
  if (Option.isNone(raw)) return Option.none<StoredRelayCliSession>();
  return decodeStoredCliSession(bytesToString(raw.value));
});

export const saveRelayCliSession = Effect.fn("relayState.saveCliSession")(function* (
  session: StoredRelayCliSession,
) {
  const normalizedUrl = normalizeRelayUrl(session.relayUrl);
  if (normalizedUrl === null) {
    return yield* new RelayStateValidationError({
      field: "relayUrl",
      message: "Relay URL must use https://, or http:// on loopback, RFC1918 LAN, or Tailscale.",
    });
  }
  const normalized: StoredRelayCliSession = {
    ...session,
    relayUrl: TrimmedNonEmptyString.make(normalizedUrl),
  };
  const encoded = yield* encodeStoredCliSession(normalized);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.set(SELF_HOSTED_RELAY_CLI_SESSION_SECRET, stringToBytes(encoded));
  return normalized;
});

export const clearRelayCliSession = Effect.fn("relayState.clearCliSession")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.remove(SELF_HOSTED_RELAY_CLI_SESSION_SECRET);
});
