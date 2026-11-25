import type { RelayUserId } from "@t3tools/contracts/agentVelaRelay";
import { AgentVelaRelay } from "@t3tools/client-runtime/relay";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { T, useGT, useMessages, Var } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useSelfHostedRelaySession } from "../../state/relay";
import { Button } from "../ui/button";
import { SettingsSection } from "../settings/settingsLayout";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { AdminInvitesSection } from "./RelayAdminInvitesSection";
import { AdminTunnelsSection } from "./RelayAdminTunnelsSection";
import { AdminUsersSection } from "./RelayAdminUsersSection";

type AdminTab = "tunnels" | "users" | "invites";

const adminTunnelsAtom = connectionAtomRuntime.atom(
  AgentVelaRelay.AgentVelaRelayClient.pipe(Effect.flatMap((client) => client.listTunnels)),
);

const adminUsersAtom = connectionAtomRuntime.atom(
  AgentVelaRelay.AgentVelaRelayClient.pipe(Effect.flatMap((client) => client.listUsers)),
);

const adminInvitesAtom = connectionAtomRuntime.atom(
  AgentVelaRelay.AgentVelaRelayClient.pipe(Effect.flatMap((client) => client.listInvites)),
);

function refreshAdminAtoms(): void {
  appAtomRegistry.refresh(adminTunnelsAtom);
  appAtomRegistry.refresh(adminUsersAtom);
  appAtomRegistry.refresh(adminInvitesAtom);
}

export function RelayAdminPanel() {
  const gt = useGT();
  const resolve = useMessages();
  const session = useSelfHostedRelaySession();
  const [tab, setTab] = useState<AdminTab>("tunnels");

  if (session.status !== "signed_in" || session.user.role !== "admin") {
    return null;
  }

  return (
    <RelayAdminPanelContent
      currentUserId={session.user.userId}
      tab={tab}
      onTabChange={setTab}
      gt={gt}
      resolve={resolve}
    />
  );
}

function RelayAdminPanelContent({
  currentUserId,
  tab,
  onTabChange,
  gt,
  resolve,
}: {
  readonly currentUserId: RelayUserId;
  readonly tab: AdminTab;
  readonly onTabChange: (tab: AdminTab) => void;
  readonly gt: ReturnType<typeof useGT>;
  readonly resolve: ReturnType<typeof useMessages>;
}) {
  const tunnelsResult = useAtomValue(adminTunnelsAtom);
  const usersResult = useAtomValue(adminUsersAtom);
  const invitesResult = useAtomValue(adminInvitesAtom);

  const tunnels = tunnelsResult._tag === "Success" ? tunnelsResult.value : [];
  const users = usersResult._tag === "Success" ? usersResult.value : [];
  const invites = invitesResult._tag === "Success" ? invitesResult.value : [];
  const loading = tunnelsResult.waiting || usersResult.waiting || invitesResult.waiting;

  const failedResult = [tunnelsResult, usersResult, invitesResult].find(
    (res) => res._tag === "Failure",
  );
  const error =
    failedResult && failedResult._tag === "Failure"
      ? (() => {
          const cause = Cause.squash(failedResult.cause);
          return (
            (cause instanceof Error ? thrownErrorMessage(cause, resolve) : null) ??
            gt("Could not load Relay admin data.")
          );
        })()
      : null;

  return (
    <SettingsSection
      id="relay-admin"
      title={gt("Relay administration")}
      headerAction={
        <Button size="sm" variant="outline" disabled={loading} onClick={refreshAdminAtoms}>
          <RefreshCwIcon className="size-3.5" />
          <T>Refresh</T>
        </Button>
      }
    >
      <div className="space-y-4 p-4">
        <ToggleGroup
          value={[tab]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "tunnels" || next === "users" || next === "invites") onTabChange(next);
          }}
        >
          <Toggle value="tunnels">
            <T>
              Live tunnels (<Var>{tunnels.length}</Var>)
            </T>
          </Toggle>
          <Toggle value="users">
            <T>
              Users (<Var>{users.length}</Var>)
            </T>
          </Toggle>
          <Toggle value="invites">
            <T>
              Invites (<Var>{invites.length}</Var>)
            </T>
          </Toggle>
        </ToggleGroup>

        {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}

        {tab === "tunnels" ? (
          <AdminTunnelsSection tunnels={tunnels} onChanged={refreshAdminAtoms} />
        ) : tab === "users" ? (
          <AdminUsersSection
            users={users}
            currentUserId={currentUserId}
            onChanged={refreshAdminAtoms}
          />
        ) : (
          <AdminInvitesSection invites={invites} onChanged={refreshAdminAtoms} />
        )}
      </div>
    </SettingsSection>
  );
}
