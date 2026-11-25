import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthRelayConfigureScope,
  EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const testState = vi.hoisted(() => ({
  scopes: new Set<string>(),
  signedIn: true,
  linkHost: vi.fn(),
  unlinkHost: vi.fn(),
  refreshDiscovery: vi.fn(),
  refreshLink: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("../components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } as never };
});
vi.mock(import("../state/relay"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useSelfHostedRelaySession: () =>
      testState.signedIn
        ? {
            status: "signed_in" as const,
            relayUrl: "https://relay.example.com",
            user: {
              userId: "user-1" as never,
              username: "alice" as never,
              role: "admin" as const,
              disabled: false,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            accessTokenExpiresAt: "2026-01-01T01:00:00.000Z",
            refreshTokenExpiresAt: "2026-01-02T00:00:00.000Z",
          }
        : { status: "signed_out" as const, relayUrl: null, user: null },
    selfHostedRelay: {
      ...actual.selfHostedRelay,
      linkHost: testState.linkHost as never,
      unlinkHost: testState.unlinkHost as never,
      refreshDiscovery: testState.refreshDiscovery as never,
    } as never,
  };
});
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (_environmentId, scope) => testState.scopes.has(scope),
  readEnvironmentCanConfigureRelay: () => testState.scopes.has(AuthRelayConfigureScope),
  useEnvironmentCanConfigureRelay: () => testState.scopes.has(AuthRelayConfigureScope),
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("./cloudLinkState"), async (original) => ({
  ...(await original()),
  useCloudLinkState: ((environmentId: EnvironmentId | null) => ({
    target: environmentId === null ? null : { environmentId },
    data: null,
    error: null,
    isPending: false,
    refresh: testState.refreshLink,
  })) as never,
}));
vi.mock(import("./hostRelayState"), async (original) => ({
  ...(await original()),
  refreshHostRelayStatus: testState.refreshLink,
}));

import { useCloudLinkController } from "./useCloudLinkController";

const targetId = EnvironmentId.make("service");
type Controller = ReturnType<typeof useCloudLinkController>;

function ControllerProbe({ onRender }: { onRender: (controller: Controller) => void }) {
  const value = useCloudLinkController(targetId);
  useLayoutEffect(() => {
    onRender(value);
  });
  return null;
}

describe("useCloudLinkController", () => {
  it("links and unlinks host relay using self-hosted relay commands", async () => {
    testState.scopes = new Set([AuthRelayReadScope, AuthRelayWriteScope, AuthRelayConfigureScope]);
    testState.signedIn = true;
    testState.linkHost.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    testState.unlinkHost.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    testState.refreshDiscovery.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    testState.refreshLink.mockReset();

    let latest!: Controller;
    await using _screen = await render(<ControllerProbe onRender={(c) => (latest = c)} />);

    let ok = false;
    await act(async () => {
      ok = await latest.reconcileCloudState({ managedTunnel: true, publish: false });
    });
    expect(ok).toBe(true);
    expect(testState.linkHost).toHaveBeenCalledWith(targetId);
    expect(testState.refreshDiscovery).toHaveBeenCalled();

    await act(async () => {
      ok = await latest.reconcileCloudState({ managedTunnel: false, publish: false });
    });
    expect(ok).toBe(true);
    expect(testState.unlinkHost).toHaveBeenCalledWith(targetId);
  });

  it("blocks linking when signed out", async () => {
    testState.scopes = new Set([AuthRelayReadScope, AuthRelayWriteScope, AuthRelayConfigureScope]);
    testState.signedIn = false;
    testState.linkHost.mockReset();

    let latest!: Controller;
    await using _screen = await render(<ControllerProbe onRender={(c) => (latest = c)} />);

    let ok = true;
    await act(async () => {
      ok = await latest.reconcileCloudState({ managedTunnel: true, publish: false });
    });
    expect(ok).toBe(false);
    expect(testState.linkHost).not.toHaveBeenCalled();
  });
});
