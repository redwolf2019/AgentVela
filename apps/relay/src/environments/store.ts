import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  RelayEndpointKey,
  RelayEnrollmentTokenId,
  RelayUserId,
  RelayUserRole,
  RelayUsername,
  type AgentVelaRelayEndpoint,
} from "@t3tools/contracts/agentVelaRelay";
import * as Schema from "effect/Schema";

export const EnvironmentRowSchema = Schema.Struct({
  environment_id: EnvironmentId,
  user_id: RelayUserId,
  endpoint_key: RelayEndpointKey,
  label: TrimmedNonEmptyString,
  environment_public_key: TrimmedNonEmptyString,
  descriptor_json: Schema.String,
  credential_hash: Schema.String,
  linked_at: IsoDateTime,
  last_seen_at: Schema.NullOr(IsoDateTime),
});

export const EnvironmentWithOwnerRowSchema = Schema.Struct({
  ...EnvironmentRowSchema.fields,
  username: RelayUsername,
  owner_role: RelayUserRole,
});

export const EnrollmentTokenRowSchema = Schema.Struct({
  token_id: RelayEnrollmentTokenId,
  user_id: RelayUserId,
  token_hash: Schema.String,
  label_hint: Schema.NullOr(Schema.String),
  expires_at: IsoDateTime,
  consumed_at: Schema.NullOr(IsoDateTime),
});

export const ChallengeRowSchema = Schema.Struct({
  challenge_hash: Schema.String,
  kind: Schema.Literals(["link", "enroll"]),
  user_id: RelayUserId,
  enrollment_token_id: Schema.NullOr(RelayEnrollmentTokenId),
  expires_at: IsoDateTime,
  consumed_at: Schema.NullOr(IsoDateTime),
});

export const decodeEnvironmentRows = Schema.decodeUnknownEffect(Schema.Array(EnvironmentRowSchema));
export const decodeEnvironmentOwnerRows = Schema.decodeUnknownEffect(
  Schema.Array(EnvironmentWithOwnerRowSchema),
);
export const decodeEnrollmentRows = Schema.decodeUnknownEffect(
  Schema.Array(EnrollmentTokenRowSchema),
);
export const decodeChallengeRows = Schema.decodeUnknownEffect(Schema.Array(ChallengeRowSchema));
export const parseDescriptor = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ExecutionEnvironmentDescriptor),
);
export const stringifyDescriptor = Schema.encodeEffect(
  Schema.fromJsonString(ExecutionEnvironmentDescriptor),
);

export interface StoredEnvironmentInfo {
  readonly environmentId: EnvironmentId;
  readonly userId: RelayUserId;
  readonly username: RelayUsername;
  readonly endpointKey: RelayEndpointKey;
  readonly endpoint: AgentVelaRelayEndpoint;
  readonly label: typeof TrimmedNonEmptyString.Type;
  readonly environmentPublicKey: typeof TrimmedNonEmptyString.Type;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly linkedAt: IsoDateTime;
  readonly lastSeenAt: IsoDateTime | null;
}
