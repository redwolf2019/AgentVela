import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { LogInIcon, LogOutIcon, RadioIcon } from "lucide-react";

import { openRelayAuthDialog } from "../../cloud/relayAuthDialog";
import { selfHostedRelay, useSelfHostedRelaySession } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { formatRelayHostLabel } from "./relayUiHelpers";

export function RelaySidebarAccount() {
  const session = useSelfHostedRelaySession();
  if (session.status === "signed_in") {
    return null;
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={() => openRelayAuthDialog()}>
          <LogInIcon />
          <span>
            <T>Sign in to Relay</T>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function RelaySidebarAvatar() {
  const gt = useGT();
  const navigate = useNavigate();
  const session = useSelfHostedRelaySession();
  const logout = useAtomCommand(selfHostedRelay.logout, { reportFailure: false });

  if (session.status !== "signed_in") {
    return null;
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex items-center gap-1.5">
          <SidebarMenuButton onClick={() => void navigate({ to: "/settings/relay" })}>
            <RadioIcon />
            <div className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate text-xs font-medium">{session.user.username}</span>
              <span className="truncate text-3xs text-muted-foreground">
                {formatRelayHostLabel(session.relayUrl)}
              </span>
            </div>
            {session.user.role === "admin" ? <Badge size="sm">{gt("Admin")}</Badge> : null}
          </SidebarMenuButton>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Sign out of Relay")}
            onClick={() => void logout()}
          >
            <LogOutIcon className="size-3.5" />
          </Button>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
