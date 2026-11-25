import type { EnvironmentId } from "@t3tools/contracts";
import type {
  RelayAdminCreateInviteRequest,
  RelayAdminCreateUserRequest,
  RelayAdminUpdateUserRequest,
  RelayCreateEnrollmentTokenRequest,
  RelayDeviceAuthApproveRequest,
  RelayInviteId,
  RelayLoginRequest,
  RelayRegisterRequest,
  RelayUserId,
} from "@t3tools/contracts/agentVelaRelay";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as HttpClient from "effect/http/HttpClient";
import { AsyncResult, Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { AgentVelaRelayClient } from "../relay/agentVelaRelayClient.ts";
import {
  linkHostToRelay,
  readHostRelayStatus,
  reconnectHostRelay,
  unlinkHostFromRelay,
} from "../relay/hostControl.ts";
import {
  EMPTY_SELF_HOSTED_RELAY_DISCOVERY_STATE,
  SelfHostedRelayDiscovery,
  type SelfHostedRelayDiscoveryState,
} from "../relay/presence.ts";
import { RelayUrlConfig, type RelayUrlConfigState } from "../relay/relayConfig.ts";
import { RelayAuthSession, type RelaySessionState } from "../relay/relaySession.ts";
import { createAtomCommandScheduler, createRuntimeCommand } from "./runtime.ts";

export type SelfHostedRelayRuntimeServices =
  | RelayUrlConfig
  | RelayAuthSession
  | AgentVelaRelayClient
  | SelfHostedRelayDiscovery
  | EnvironmentRegistry.EnvironmentRegistry
  | HttpClient.HttpClient;

type AnySelfHostedRuntime<R, E> = Atom.AtomRuntime<SelfHostedRelayRuntimeServices | R, E>;

const INITIAL_URL_STATE: RelayUrlConfigState = {
  relayUrl: null,
  parsed: null,
  source: "unset",
};

const INITIAL_SESSION_STATE: RelaySessionState = {
  status: "signed_out",
  relayUrl: null,
  user: null,
};

function createStateAtoms<R, E>(runtime: AnySelfHostedRuntime<R, E>) {
  const relayUrlAtom = runtime.atom(
    Stream.unwrap(
      RelayUrlConfig.pipe(Effect.map((config) => SubscriptionRef.changes(config.state))),
    ),
    { initialValue: INITIAL_URL_STATE },
  );
  const relayUrlValueAtom = Atom.make((get) =>
    AsyncResult.getOrElse(get(relayUrlAtom), () => INITIAL_URL_STATE),
  ).pipe(Atom.withLabel("self-hosted-relay:url"));

  const sessionAtom = runtime.atom(
    Stream.unwrap(
      RelayAuthSession.pipe(Effect.map((session) => SubscriptionRef.changes(session.state))),
    ),
    { initialValue: INITIAL_SESSION_STATE },
  );
  const sessionValueAtom = Atom.make((get) =>
    AsyncResult.getOrElse(get(sessionAtom), () => INITIAL_SESSION_STATE),
  ).pipe(Atom.withLabel("self-hosted-relay:session"));

  const discoveryAtom = runtime.atom(
    Stream.unwrap(
      SelfHostedRelayDiscovery.pipe(
        Effect.map((discovery) => SubscriptionRef.changes(discovery.state)),
      ),
    ),
    { initialValue: EMPTY_SELF_HOSTED_RELAY_DISCOVERY_STATE },
  );
  const discoveryValueAtom = Atom.make((get): SelfHostedRelayDiscoveryState =>
    AsyncResult.getOrElse(get(discoveryAtom), () => EMPTY_SELF_HOSTED_RELAY_DISCOVERY_STATE),
  ).pipe(Atom.withLabel("self-hosted-relay:discovery"));

  return {
    relayUrlAtom,
    relayUrlValueAtom,
    sessionAtom,
    sessionValueAtom,
    discoveryAtom,
    discoveryValueAtom,
  };
}

function makeRelayCommand<R, E, W, A, E2>(
  runtime: AnySelfHostedRuntime<R, E>,
  scheduler: ReturnType<typeof createAtomCommandScheduler>,
  label: string,
  execute: (input: W) => Effect.Effect<A, E2, SelfHostedRelayRuntimeServices>,
  concurrency?: { readonly mode: "serial" | "singleFlight"; readonly key: () => string },
) {
  return createRuntimeCommand<SelfHostedRelayRuntimeServices | R, E, W, A, E2>(runtime, {
    label: `self-hosted-relay:${label}`,
    scheduler,
    ...(concurrency ? { concurrency } : {}),
    execute,
  });
}

function createAuthCommands<R, E>(
  runtime: AnySelfHostedRuntime<R, E>,
  scheduler: ReturnType<typeof createAtomCommandScheduler>,
) {
  return {
    setRelayUrl: makeRelayCommand(
      runtime,
      scheduler,
      "set-url",
      (relayUrl: string | null) =>
        RelayUrlConfig.pipe(Effect.flatMap((config) => config.setRelayUrl(relayUrl))),
      { mode: "serial", key: () => "relay-config" },
    ),
    resetRelayUrl: makeRelayCommand(
      runtime,
      scheduler,
      "reset-url",
      (_: void) => RelayUrlConfig.pipe(Effect.flatMap((config) => config.resetToDefault)),
      { mode: "serial", key: () => "relay-config" },
    ),
    getAuthConfig: makeRelayCommand(runtime, scheduler, "auth-config", (_: void) =>
      RelayAuthSession.pipe(Effect.flatMap((session) => session.getConfig)),
    ),
    checkHealth: makeRelayCommand(runtime, scheduler, "health", (_: void) =>
      RelayAuthSession.pipe(Effect.flatMap((session) => session.checkHealth)),
    ),
    login: makeRelayCommand(runtime, scheduler, "login", (input: RelayLoginRequest) =>
      RelayAuthSession.pipe(Effect.flatMap((session) => session.login(input))),
    ),
    register: makeRelayCommand(runtime, scheduler, "register", (input: RelayRegisterRequest) =>
      RelayAuthSession.pipe(Effect.flatMap((session) => session.register(input))),
    ),
    logout: makeRelayCommand(runtime, scheduler, "logout", (_: void) =>
      RelayAuthSession.pipe(Effect.flatMap((session) => session.logout)),
    ),
    refreshSession: makeRelayCommand(runtime, scheduler, "refresh-session", (_: void) =>
      RelayAuthSession.pipe(Effect.flatMap((session) => session.refresh)),
    ),
    getMe: makeRelayCommand(runtime, scheduler, "get-me", (_: void) =>
      RelayAuthSession.pipe(Effect.flatMap((session) => session.getMe)),
    ),
    approveDeviceAuth: makeRelayCommand(
      runtime,
      scheduler,
      "approve-device-auth",
      (input: RelayDeviceAuthApproveRequest) =>
        RelayAuthSession.pipe(Effect.flatMap((session) => session.approveDeviceAuth(input))),
    ),
  };
}

function createEnvironmentAndHostCommands<R, E>(
  runtime: AnySelfHostedRuntime<R, E>,
  scheduler: ReturnType<typeof createAtomCommandScheduler>,
) {
  return {
    refreshDiscovery: makeRelayCommand(
      runtime,
      scheduler,
      "refresh-discovery",
      (_: void) => SelfHostedRelayDiscovery.pipe(Effect.flatMap((discovery) => discovery.refresh)),
      { mode: "singleFlight", key: () => "refresh" },
    ),
    checkEnvironmentStatus: makeRelayCommand(
      runtime,
      scheduler,
      "environment-status",
      (environmentId: EnvironmentId) =>
        SelfHostedRelayDiscovery.pipe(
          Effect.flatMap((discovery) => discovery.checkEnvironmentStatus(environmentId)),
        ),
    ),
    createEnrollmentToken: makeRelayCommand(
      runtime,
      scheduler,
      "create-enrollment-token",
      (input: RelayCreateEnrollmentTokenRequest | undefined) =>
        AgentVelaRelayClient.pipe(Effect.flatMap((client) => client.createEnrollmentToken(input))),
    ),
    unlinkEnvironment: makeRelayCommand(
      runtime,
      scheduler,
      "unlink-environment",
      (environmentId: EnvironmentId) =>
        AgentVelaRelayClient.pipe(
          Effect.flatMap((client) => client.unlinkEnvironment(environmentId)),
        ),
    ),
    readHostStatus: makeRelayCommand(runtime, scheduler, "host-status", readHostRelayStatus),
    linkHost: makeRelayCommand(runtime, scheduler, "link-host", linkHostToRelay),
    reconnectHost: makeRelayCommand(runtime, scheduler, "reconnect-host", reconnectHostRelay),
    unlinkHost: makeRelayCommand(runtime, scheduler, "unlink-host", unlinkHostFromRelay),
  };
}

function createAdminCommands<R, E>(
  runtime: AnySelfHostedRuntime<R, E>,
  scheduler: ReturnType<typeof createAtomCommandScheduler>,
) {
  return {
    listUsers: makeRelayCommand(runtime, scheduler, "admin-list-users", (_: void) =>
      AgentVelaRelayClient.pipe(Effect.flatMap((client) => client.listUsers)),
    ),
    createUser: makeRelayCommand(
      runtime,
      scheduler,
      "admin-create-user",
      (payload: RelayAdminCreateUserRequest) =>
        AgentVelaRelayClient.pipe(Effect.flatMap((client) => client.createUser(payload))),
    ),
    updateUser: makeRelayCommand(
      runtime,
      scheduler,
      "admin-update-user",
      (input: { readonly userId: RelayUserId; readonly patch: RelayAdminUpdateUserRequest }) =>
        AgentVelaRelayClient.pipe(
          Effect.flatMap((client) => client.updateUser(input.userId, input.patch)),
        ),
    ),
    listInvites: makeRelayCommand(runtime, scheduler, "admin-list-invites", (_: void) =>
      AgentVelaRelayClient.pipe(Effect.flatMap((client) => client.listInvites)),
    ),
    createInvite: makeRelayCommand(
      runtime,
      scheduler,
      "admin-create-invite",
      (payload: RelayAdminCreateInviteRequest | undefined) =>
        AgentVelaRelayClient.pipe(Effect.flatMap((client) => client.createInvite(payload))),
    ),
    revokeInvite: makeRelayCommand(
      runtime,
      scheduler,
      "admin-revoke-invite",
      (inviteId: RelayInviteId) =>
        AgentVelaRelayClient.pipe(Effect.flatMap((client) => client.revokeInvite(inviteId))),
    ),
    listTunnels: makeRelayCommand(runtime, scheduler, "admin-list-tunnels", (_: void) =>
      AgentVelaRelayClient.pipe(Effect.flatMap((client) => client.listTunnels)),
    ),
    kickTunnel: makeRelayCommand(
      runtime,
      scheduler,
      "admin-kick-tunnel",
      (input: { readonly environmentId: EnvironmentId; readonly reason?: string }) =>
        AgentVelaRelayClient.pipe(
          Effect.flatMap((client) => client.kickTunnel(input.environmentId, input.reason)),
        ),
    ),
  };
}

export function createSelfHostedRelayAtoms<R, E>(runtime: AnySelfHostedRuntime<R, E>) {
  const scheduler = createAtomCommandScheduler();
  return {
    ...createStateAtoms(runtime),
    ...createAuthCommands(runtime, scheduler),
    ...createEnvironmentAndHostCommands(runtime, scheduler),
    ...createAdminCommands(runtime, scheduler),
  };
}
