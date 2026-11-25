import { TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  RELAY_USERNAME_PATTERN,
  type RelayAuthConfigResponse,
} from "@t3tools/contracts/agentVelaRelay";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { selfHostedRelay, useSelfHostedRelayUrl } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveDefaultRelayUrl } from "./publicConfig";

export function RelayAuthForm() {
  const gt = useGT();
  const resolve = useMessages();
  const insets = useSafeAreaInsets();
  const urlState = useSelfHostedRelayUrl();
  const defaultUrl = resolveDefaultRelayUrl();

  const setRelayUrlCmd = useAtomCommand(selfHostedRelay.setRelayUrl, { reportFailure: false });
  const resetRelayUrlCmd = useAtomCommand(selfHostedRelay.resetRelayUrl, { reportFailure: false });
  const checkHealthCmd = useAtomCommand(selfHostedRelay.checkHealth, { reportFailure: false });
  const getAuthConfigCmd = useAtomCommand(selfHostedRelay.getAuthConfig, { reportFailure: false });
  const loginCmd = useAtomCommand(selfHostedRelay.login, { reportFailure: false });
  const registerCmd = useAtomCommand(selfHostedRelay.register, { reportFailure: false });

  const [urlInput, setUrlInput] = useState(urlState.relayUrl ?? defaultUrl ?? "");
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [authConfig, setAuthConfig] = useState<RelayAuthConfigResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverNote, setServerNote] = useState<string | null>(null);

  const failureText = (cause: unknown, fallback: string) =>
    (cause instanceof Error ? thrownErrorMessage(cause, resolve) : null) ?? fallback;

  const probeServer = async () => {
    const health = await checkHealthCmd();
    if (health._tag !== "Success") {
      setError(
        failureText(squashAtomCommandFailure(health), gt("Could not reach the relay server.")),
      );
      return false;
    }
    const config = await getAuthConfigCmd();
    if (config._tag === "Success") {
      setAuthConfig(config.value);
      setServerNote(
        config.value.registrationOpen
          ? gt("Connected to v{version}. Registration is open.", {
              version: health.value.version,
            })
          : gt("Connected to v{version}. Registration requires an invite code.", {
              version: health.value.version,
            }),
      );
    } else {
      setAuthConfig(null);
      setServerNote(gt("Connected to v{version}.", { version: health.value.version }));
    }
    return true;
  };

  const handleSaveUrl = async () => {
    setError(null);
    setServerNote(null);
    setBusy(true);
    const saved = await setRelayUrlCmd(urlInput.trim() || null);
    if (saved._tag !== "Success") {
      setBusy(false);
      setError(failureText(squashAtomCommandFailure(saved), gt("Invalid relay server URL.")));
      return;
    }
    if (saved.value.relayUrl !== null) {
      await probeServer();
    }
    setBusy(false);
  };

  const handleResetUrl = async () => {
    setError(null);
    setServerNote(null);
    setBusy(true);
    const reset = await resetRelayUrlCmd();
    if (reset._tag === "Success") {
      setUrlInput(reset.value.relayUrl ?? "");
      if (reset.value.relayUrl) {
        await probeServer();
      }
    }
    setBusy(false);
  };

  const handleSubmitAuth = async () => {
    setError(null);
    const trimmedUser = username.trim();
    const trimmedPass = password.trim();
    if (!RELAY_USERNAME_PATTERN.test(trimmedUser)) {
      setError(gt("Username must start with a letter or digit and be 2-64 characters."));
      return;
    }
    if (trimmedPass.length === 0) {
      setError(gt("Enter a password."));
      return;
    }
    setBusy(true);
    if (urlInput.trim() && urlInput.trim() !== urlState.relayUrl) {
      const saved = await setRelayUrlCmd(urlInput.trim());
      if (saved._tag !== "Success") {
        setBusy(false);
        setError(failureText(squashAtomCommandFailure(saved), gt("Invalid relay server URL.")));
        return;
      }
    }
    const result =
      mode === "signin"
        ? await loginCmd({
            username: TrimmedNonEmptyString.make(trimmedUser),
            password: TrimmedNonEmptyString.make(trimmedPass),
          })
        : await registerCmd({
            username: TrimmedNonEmptyString.make(trimmedUser),
            password: TrimmedNonEmptyString.make(trimmedPass),
            ...(inviteCode.trim().length > 0
              ? { inviteCode: TrimmedNonEmptyString.make(inviteCode.trim()) }
              : {}),
          });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(
        failureText(
          squashAtomCommandFailure(result),
          mode === "signin" ? gt("Sign-in failed.") : gt("Registration failed."),
        ),
      );
    }
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerStyle={{
        gap: 20,
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: Math.max(insets.bottom, 18) + 24,
      }}
    >
      <ListSection
        title={gt("Relay server")}
        footer={
          serverNote ??
          gt("Enter the HTTP or HTTPS URL of your self-hosted agent-vela-relay instance.")
        }
      >
        <View collapsable={false} className="gap-3 p-4">
          <AppTextInput
            accessibilityLabel={gt("Relay server URL")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            keyboardType="url"
            placeholder={gt("https://relay.example.com")}
            value={urlInput}
            onChangeText={setUrlInput}
          />
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={busy ? gt("Connecting…") : gt("Save & test")}
              size="compact"
              tone="secondary"
              loading={busy}
              onPress={() => void handleSaveUrl()}
            />
            {defaultUrl !== null ? (
              <Button
                label={gt("Reset")}
                size="compact"
                tone="text"
                disabled={busy}
                onPress={() => void handleResetUrl()}
              />
            ) : null}
          </View>
        </View>
      </ListSection>

      <ListSection title={gt("Account")}>
        <View collapsable={false} className="gap-3 p-4">
          <View className="flex-row gap-2">
            <Button
              label={gt("Sign in")}
              size="compact"
              tone={mode === "signin" ? "primary" : "secondary"}
              disabled={busy}
              onPress={() => {
                setMode("signin");
                setError(null);
              }}
            />
            <Button
              label={gt("Register")}
              size="compact"
              tone={mode === "register" ? "primary" : "secondary"}
              disabled={busy}
              onPress={() => {
                setMode("register");
                setError(null);
              }}
            />
          </View>

          <AppTextInput
            accessibilityLabel={gt("Username")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            placeholder={gt("Username")}
            value={username}
            onChangeText={setUsername}
          />
          <AppTextInput
            accessibilityLabel={gt("Password")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            placeholder={gt("Password")}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
          {mode === "register" ? (
            <AppTextInput
              accessibilityLabel={gt("Invite code")}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              placeholder={
                authConfig?.registrationOpen === false
                  ? gt("Invite code (required)")
                  : gt("Invite code (optional)")
              }
              value={inviteCode}
              onChangeText={setInviteCode}
            />
          ) : null}

          {error ? (
            <Text className={cn("text-sm leading-normal text-danger-foreground")}>{error}</Text>
          ) : null}

          <Button
            fullWidth
            label={mode === "signin" ? gt("Sign in") : gt("Create account")}
            tone="primary"
            loading={busy}
            onPress={() => void handleSubmitAuth()}
          />
        </View>
      </ListSection>
    </ScrollView>
  );
}
