import { errorDisplayMessage, findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { type ReactNode, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { m, type MessageResolver } from "../../i18n/messages";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  relayEnvironmentDiscovery,
  selfHostedRelay,
  useSelfHostedRelayDiscovery,
  useSelfHostedRelaySession,
} from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  deregisterManagedRelayEnvironmentCommand,
  useManagedRelayEnvironments,
} from "./managedRelayState";

const linkedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function linkedAtLabel(value: string, resolve: MessageResolver): string {
  const linkedAt = new Date(value);
  return Number.isNaN(linkedAt.getTime())
    ? resolve(msg("Link date unavailable"))
    : resolve(msg("Linked {date}", { date: linkedAtFormatter.format(linkedAt) }));
}

function endpointLabel(
  environment: RelayClientEnvironmentRecord,
  resolve: MessageResolver,
): string {
  return environment.endpoint.providerKind === "t3_relay"
    ? resolve(msg("Self-hosted relay"))
    : environment.endpoint.providerKind === "cloudflare_tunnel"
      ? resolve(msg("Managed tunnel"))
      : resolve(msg("Activity publishing only"));
}

function confirmDeregister(environment: RelayClientEnvironmentRecord, onConfirm: () => void) {
  Dialog.confirm({
    title: m(msg("Deregister server?")),
    message: m(
      msg(
        "“{environment}” will be removed from this account. Relay access will be revoked while local connections on your devices remain unchanged.",
        { environment: environment.label },
      ),
    ),
    confirmText: m(msg("Deregister")),
    destructive: true,
    onConfirm,
  });
}

export function T3ConnectProfilePage() {
  const gt = useGT();
  const resolve = useMessages();
  const insets = useSafeAreaInsets();
  const session = useSelfHostedRelaySession();
  const discovery = useSelfHostedRelayDiscovery();
  const environmentsState = useManagedRelayEnvironments();
  const logoutCmd = useAtomCommand(selfHostedRelay.logout, { reportFailure: false });
  const deregisterEnvironment = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    reportFailure: false,
  });
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refreshAfterMutation, {
    reportFailure: false,
  });
  const [deregisteringEnvironmentId, setDeregisteringEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const mutationPendingRef = useRef(false);
  const [removedEnvironments, setRemovedEnvironments] = useState<{
    readonly accountId: string | null;
    readonly linkedAtById: ReadonlyMap<EnvironmentId, string>;
  }>({ accountId: null, linkedAtById: new Map() });

  const handleSignOut = () => {
    Dialog.confirm({
      title: gt("Sign out of Relay?"),
      message: gt("You can sign back in at any time."),
      confirmText: gt("Sign out"),
      destructive: true,
      onConfirm: () => {
        setSigningOut(true);
        void logoutCmd().finally(() => setSigningOut(false));
      },
    });
  };

  const handleDeregister = async (environment: RelayClientEnvironmentRecord) => {
    const accountId = environmentsState.accountId;
    if (!accountId || mutationPendingRef.current) return;

    mutationPendingRef.current = true;
    setDeregisteringEnvironmentId(environment.environmentId);
    const result = await deregisterEnvironment({
      accountId,
      environmentId: environment.environmentId,
    });
    mutationPendingRef.current = false;
    setDeregisteringEnvironmentId(null);

    if (result._tag === "Success") {
      setRemovedEnvironments((current) => {
        const linkedAtById = new Map(current.accountId === accountId ? current.linkedAtById : []);
        linkedAtById.set(environment.environmentId, environment.linkedAt);
        return { accountId, linkedAtById };
      });
      environmentsState.refresh();
      void refreshRelayEnvironments();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;

    const cause = squashAtomCommandFailure(result);
    const message =
      cause instanceof Error
        ? (errorDisplayMessage(cause, resolve) ?? cause.message)
        : gt("Could not deregister the server.");
    const traceId = findErrorTraceId(cause);
    Dialog.alert(
      gt("Could not deregister server"),
      traceId ? gt("{message}\n\nTrace ID: {traceId}", { message, traceId }) : message,
      traceId
        ? [
            {
              text: gt("Copy trace ID"),
              onPress: () => copyTextWithHaptic(traceId, { target: "connection-trace-id" }),
            },
            { text: gt("OK"), style: "cancel" },
          ]
        : undefined,
    );
  };

  const removedEnvironmentLinkedAt =
    removedEnvironments.accountId === environmentsState.accountId
      ? removedEnvironments.linkedAtById
      : new Map<EnvironmentId, string>();
  const environments = (environmentsState.data ?? []).filter(
    (environment) =>
      removedEnvironmentLinkedAt.get(environment.environmentId) !== environment.linkedAt,
  );
  const isInitialLoad =
    !environmentsState.accountId || (environmentsState.data === null && !environmentsState.error);
  const errorTraceId = environmentsState.errorTraceId;
  const environmentMenuActions = [
    {
      id: "deregister",
      title: gt("Deregister"),
      image: "trash",
      attributes: { destructive: true },
    },
  ] satisfies MenuAction[];

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentContainerStyle={{
        gap: 20,
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: Math.max(insets.bottom, 18) + 24,
      }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        <RefreshControl
          refreshing={environmentsState.isPending && environmentsState.data !== null}
          onRefresh={environmentsState.refresh}
        />
      }
    >
      {session.status === "signed_in" ? (
        <ListSection title={gt("Relay account")}>
          <ProfileRow
            title={session.user.username}
            subtitle={`${session.relayUrl} · ${session.user.role === "admin" ? gt("Admin") : gt("Member")} · ${discovery.connectionState}`}
          />
          <View className="p-4">
            <Button
              fullWidth
              label={gt("Sign out")}
              tone="danger"
              loading={signingOut}
              onPress={handleSignOut}
            />
          </View>
        </ListSection>
      ) : null}

      <ListSection
        title={gt("Registered servers")}
        footer={gt("Connections on this device are managed in Settings.")}
      >
        {environmentsState.error ? (
          <ProfileRow
            title={gt("Could not load Relay environments")}
            subtitle={environmentsState.error}
            accessory={
              errorTraceId ? (
                <Button
                  label={gt("Copy trace ID")}
                  size="compact"
                  tone="secondary"
                  onPress={() =>
                    copyTextWithHaptic(errorTraceId, { target: "connection-trace-id" })
                  }
                />
              ) : undefined
            }
          />
        ) : isInitialLoad ? (
          <View className="flex-row items-center gap-3 px-4 py-4">
            <AppActivityIndicator colorClassName="accent-foreground-muted" size="small" />
            <Text className="text-base text-foreground-muted">
              <T>Loading environments</T>
            </Text>
          </View>
        ) : environments.length > 0 ? (
          environments.map((environment) => (
            <ProfileRow
              key={environment.environmentId}
              title={environment.label}
              subtitle={`${linkedAtLabel(environment.linkedAt, resolve)} · ${endpointLabel(environment, resolve)}`}
              accessory={
                deregisteringEnvironmentId === environment.environmentId ? (
                  <AppActivityIndicator colorClassName="accent-foreground-muted" size="small" />
                ) : (
                  <View pointerEvents={deregisteringEnvironmentId === null ? "auto" : "none"}>
                    <Menu
                      actions={environmentMenuActions}
                      isAnchoredToRight
                      onPressAction={() =>
                        confirmDeregister(environment, () => void handleDeregister(environment))
                      }
                    >
                      <Pressable
                        accessibilityLabel={gt("Actions for {environment}", {
                          environment: environment.label,
                        })}
                        accessibilityRole="button"
                        disabled={deregisteringEnvironmentId !== null}
                        className="size-[30px] items-center justify-center active:opacity-60 disabled:opacity-50"
                      >
                        <View className="rotate-90">
                          <SymbolView
                            name="ellipsis"
                            size={18}
                            tintColorClassName="accent-foreground-muted"
                            type="monochrome"
                          />
                        </View>
                      </Pressable>
                    </Menu>
                  </View>
                )
              }
            />
          ))
        ) : (
          <ProfileRow
            title={gt("No servers registered")}
            subtitle={gt("Link a server from its local Settings to reach it through Relay.")}
          />
        )}
      </ListSection>
    </ScrollView>
  );
}

function ProfileRow(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly accessory?: ReactNode;
}) {
  return (
    <View
      collapsable={false}
      className="flex-row items-center gap-3 border-b border-border px-4 py-3.5"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={2}>
          {props.subtitle}
        </Text>
      </View>
      {props.accessory}
    </View>
  );
}
