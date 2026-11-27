import type { ServerSettings } from "@t3tools/contracts";
import { resolveMirrorUrlOverride } from "@t3tools/shared/url";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

interface UpdateMirrorSettingsRowProps {
  readonly id?: string | undefined;
  readonly savedMirrorUrl: string | null;
  readonly effectiveBaseUrl?: string | null | undefined;
  readonly managedReason?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly settingKeys?: readonly (keyof ServerSettings)[];
  readonly managedPaths?: readonly string[];
  readonly onSave: (nextMirrorUrl: string | null) => Promise<void> | void;
}

export function UpdateMirrorSettingsRow({
  id,
  savedMirrorUrl,
  effectiveBaseUrl,
  managedReason,
  disabled = false,
  settingKeys,
  managedPaths,
  onSave,
}: UpdateMirrorSettingsRowProps) {
  const gt = useGT();
  const normalizedSaved = savedMirrorUrl ?? "";
  const [trackedSaved, setTrackedSaved] = useState(normalizedSaved);
  const [draft, setDraft] = useState(normalizedSaved);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  if (trackedSaved !== normalizedSaved) {
    setTrackedSaved(normalizedSaved);
    setDraft(normalizedSaved);
    setValidationError(null);
  }

  const trimmedDraft = draft.trim();
  const isDirty = trimmedDraft !== normalizedSaved;
  const isLocked = disabled || managedReason !== undefined;

  const handleSave = async () => {
    if (isLocked || isSaving) return;
    let nextMirrorUrl: string | null = null;
    if (trimmedDraft.length > 0) {
      const resolved = resolveMirrorUrlOverride(trimmedDraft);
      if (resolved._tag !== "url") {
        setValidationError(
          gt("Enter a valid https:// mirror URL (or http://localhost for local testing)."),
        );
        return;
      }
      nextMirrorUrl = resolved.url;
    }

    setValidationError(null);
    setIsSaving(true);
    try {
      await onSave(nextMirrorUrl);
      setDraft(nextMirrorUrl ?? "");
      setIsSaving(false);
    } catch (error) {
      setIsSaving(false);
      throw error;
    }
  };

  const handleReset = async () => {
    if (isLocked || isSaving) return;
    setValidationError(null);
    if (normalizedSaved === "") {
      setDraft("");
      return;
    }
    setIsSaving(true);
    try {
      await onSave(null);
      setDraft("");
      setIsSaving(false);
    } catch (error) {
      setIsSaving(false);
      throw error;
    }
  };

  const description = effectiveBaseUrl ? (
    <>
      <T>Optional mirror base URL used instead of GitHub Releases.</T>{" "}
      <span className="font-mono text-2xs text-muted-foreground">{effectiveBaseUrl}</span>
    </>
  ) : (
    <T>Optional mirror base URL used instead of GitHub Releases.</T>
  );

  return (
    <SettingsRow
      id={id}
      title={gt("Update mirror")}
      description={description}
      managed={managedReason}
      {...(settingKeys ? { settingKeys } : {})}
      {...(managedPaths ? { managedPaths } : {})}
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            type="url"
            size="sm"
            className="sm:flex-1"
            value={draft}
            disabled={isLocked || isSaving}
            placeholder="https://github.com/redwolf2019/AgentVela/releases"
            aria-label={gt("Update mirror URL")}
            onChange={(event) => {
              setDraft(event.target.value);
              if (validationError !== null) setValidationError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isDirty) {
                event.preventDefault();
                void handleSave();
              }
            }}
          />
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={isLocked || isSaving || !isDirty}
              onClick={() => void handleSave()}
            >
              <T>Save</T>
            </Button>
            {normalizedSaved !== "" || trimmedDraft !== "" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={isLocked || isSaving}
                onClick={() => void handleReset()}
              >
                <T>Reset</T>
              </Button>
            ) : null}
          </div>
        </div>
        {validationError ? (
          <p className="text-xs text-destructive" role="alert">
            {validationError}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}
