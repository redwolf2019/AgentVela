import { isLoopbackHost } from "./preview.ts";

// `URL.parse` and `URL.canParse` are missing before Safari 17/18, and client code ships unpolyfilled.
export function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

export type MirrorUrlOverride =
  | { readonly _tag: "default" }
  | { readonly _tag: "off" }
  | { readonly _tag: "url"; readonly url: string }
  | { readonly _tag: "invalid"; readonly value: string };

const DISABLED_MIRROR_VALUES = new Set(["off", "none", "disabled"]);

export function resolveMirrorUrlOverride(raw: string | undefined): MirrorUrlOverride {
  const trimmed = raw?.trim();
  if (!trimmed) return { _tag: "default" };
  if (DISABLED_MIRROR_VALUES.has(trimmed.toLowerCase())) return { _tag: "off" };
  const parsed = parseUrl(trimmed);
  if (
    parsed === null ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)))
  ) {
    return { _tag: "invalid", value: trimmed };
  }
  return { _tag: "url", url: parsed.href };
}
