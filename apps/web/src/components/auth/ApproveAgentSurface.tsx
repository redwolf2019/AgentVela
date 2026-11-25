import {
  type ConnectMcpApprovalCall,
  ConnectMcpApprovalUnavailableError,
} from "@t3tools/client-runtime/state/connectMcpApproval";
import { type AuthMcpApprovalDetails, EnvironmentId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { msg, T, useGT } from "gt-react";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { openRelayAuthDialog } from "../../cloud/relayAuthDialog";
import { m } from "../../i18n/messages";
import { runConnectMcpApproval } from "../../state/connectMcpApproval";
import { selfHostedRelay, useSelfHostedRelaySession } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import {
  type McpApprovalAnswer,
  type McpApprovalTransport,
  McpConsent,
  readAuthorizationRequest,
} from "./ConnectAgentSurface";

const isUnavailable = Schema.is(ConnectMcpApprovalUnavailableError);

function readEnvironmentId(): EnvironmentId | null {
  const value = new URL(window.location.href).searchParams.get("environment");
  return value ? EnvironmentId.make(value) : null;
}

/** Sends each call with the owner's Relay session and remembers where the environment is. */
function connectTransport(
  environmentId: EnvironmentId,
  onEnvironment: (environment: { readonly url: string; readonly label: string }) => void,
): McpApprovalTransport {
  const send = async (
    call: ConnectMcpApprovalCall,
  ): Promise<McpApprovalAnswer<AuthMcpApprovalDetails>> => {
    const result = await runConnectMcpApproval(environmentId, call);
    if (Result.isFailure(result)) {
      return {
        kind: "error",
        message: isUnavailable(result.failure)
          ? result.failure.message
          : m(msg("Could not reach this environment. Try again.")),
      };
    }
    onEnvironment({
      url: result.success.environmentUrl,
      label: result.success.environmentLabel,
    });
    const { answer } = result.success;
    switch (answer.kind) {
      case "details":
        return { kind: "ok", value: answer.details };
      case "redirect":
        return { kind: "redirect", url: answer.url };
      case "refused":
        return { kind: "error", message: answer.message };
    }
  };
  return {
    load: (authorization) => send({ kind: "approval", payload: authorization }),
    decide: (authorization, decision) =>
      send({ kind: "decision", payload: { authorization, decision } }),
  };
}

export function ApproveAgentSurface() {
  const gt = useGT();
  const [environmentId] = useState(readEnvironmentId);
  const [authorization] = useState(readAuthorizationRequest);
  const [framed] = useState(() => window.top !== window.self);
  const [environment, setEnvironment] = useState<{
    readonly url: string;
    readonly label: string;
  } | null>(null);
  const [transport] = useState(() =>
    environmentId === null ? null : connectTransport(environmentId, setEnvironment),
  );
  const session = useSelfHostedRelaySession();
  const isSignedIn = session.status === "signed_in";
  const logoutCmd = useAtomCommand(selfHostedRelay.logout, { reportFailure: false });
  const signInOpened = useRef(false);

  const openSignIn = () => openRelayAuthDialog();
  const openSignInOnLoad = useEffectEvent(openSignIn);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prompts Relay sign-in when this standalone approval page loads signed out
  useEffect(() => {
    if (isSignedIn || signInOpened.current || framed) return;
    signInOpened.current = true;
    openSignInOnLoad();
  }, [framed, isSignedIn]);

  if (environmentId === null || transport === null) {
    return (
      <Message
        title={gt("This sign-in link is incomplete")}
        description={gt("Close this page and start the sign-in again from your agent.")}
      />
    );
  }

  if (framed) {
    return (
      <Message
        title={gt("Open this page in its own window")}
        description={gt("For your safety, agent sign-ins cannot be approved inside another site.")}
      />
    );
  }

  if (!isSignedIn) {
    return (
      <Message
        title={gt("Sign in to approve")}
        description={gt("Sign in to your Relay account linked to this environment.")}
      >
        <div className="mt-6">
          <Button type="button" onClick={openSignIn}>
            <T>Sign in</T>
          </Button>
        </div>
      </Message>
    );
  }

  const search = new URLSearchParams(window.location.search);
  search.delete("environment");
  return (
    <McpConsent
      authorization={authorization}
      transport={transport}
      requireLevelChoice
      environmentLabel={environment?.label}
      footer={
        <div className="mt-6 flex flex-wrap gap-2">
          {environment ? (
            <Button
              size="sm"
              variant="link"
              render={
                <a href={`${new URL("/connect-agent", environment.url).toString()}?${search}`} />
              }
            >
              <T>Use a sign-in code instead</T>
            </Button>
          ) : null}
          <Button size="sm" variant="link" onClick={() => void logoutCmd()} type="button">
            <T>Use another account</T>
          </Button>
        </div>
      }
    />
  );
}

function Message({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  const gt = useGT();
  return (
    <StandalonePage>
      <StandalonePageHeader context={gt("Agent sign-in")} title={title} description={description} />
      {children}
    </StandalonePage>
  );
}
