import * as Schema from "effect/Schema";

export class RelayConfigError extends Schema.TaggedError<
  RelayConfigError,
  { readonly brand: unique symbol }
>()("RelayConfigError", {
  message: Schema.String,
}) {
  override get name(): string {
    return "RelayConfigError";
  }
}

export interface RelayBindAddress {
  readonly host: string;
  readonly port: number;
}

export interface ParsedTomlConfig {
  server?: Record<string, string | number | boolean>;
  auth?: Record<string, string | number | boolean>;
  tunnel?: Record<string, string | number | boolean>;
  rate_limit?: Record<string, string | number | boolean>;
}

type TomlSectionName = keyof ParsedTomlConfig;

function isTomlSectionName(value: string): value is TomlSectionName {
  return value === "server" || value === "auth" || value === "tunnel" || value === "rate_limit";
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const ch = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlValue(rawValue: string, lineNumber: number): string | number | boolean {
  const trimmed = rawValue.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  throw new RelayConfigError({
    message: `Unsupported TOML value at line ${lineNumber}: ${trimmed}`,
  });
}

export function parseRelayToml(source: string): ParsedTomlConfig {
  const parsed: ParsedTomlConfig = {};
  let section: TomlSectionName | null = null;
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    const clean = stripTomlComment(lines[index] ?? "").trim();
    if (clean.length === 0) {
      continue;
    }
    if (clean.startsWith("[") && clean.endsWith("]")) {
      const sectionName = clean.slice(1, -1).trim();
      if (!isTomlSectionName(sectionName)) {
        throw new RelayConfigError({
          message: `Unknown TOML section [${sectionName}] at line ${index + 1}`,
        });
      }
      section = sectionName;
      parsed[section] ??= {};
      continue;
    }
    const equalsIndex = clean.indexOf("=");
    if (equalsIndex <= 0 || section === null) {
      throw new RelayConfigError({
        message: `Invalid TOML entry at line ${index + 1}: ${clean}`,
      });
    }
    const key = clean.slice(0, equalsIndex).trim();
    const bucket = parsed[section] ?? {};
    bucket[key] = parseTomlValue(clean.slice(equalsIndex + 1), index + 1);
    parsed[section] = bucket;
  }
  return parsed;
}

export function parseBindAddress(rawBind: string): RelayBindAddress {
  const trimmed = rawBind.trim();
  let host: string;
  let portText: string;
  if (trimmed.startsWith("[")) {
    const bracketEnd = trimmed.indexOf("]:");
    if (bracketEnd < 0) {
      throw new RelayConfigError({ message: `Invalid bind address: ${rawBind}` });
    }
    host = trimmed.slice(1, bracketEnd);
    portText = trimmed.slice(bracketEnd + 2);
  } else {
    const colonIndex = trimmed.lastIndexOf(":");
    if (colonIndex <= 0) {
      throw new RelayConfigError({ message: `Invalid bind address: ${rawBind}` });
    }
    host = trimmed.slice(0, colonIndex);
    portText = trimmed.slice(colonIndex + 1);
  }
  if (!/^\d+$/.test(portText)) {
    throw new RelayConfigError({ message: `Invalid bind port in ${rawBind}` });
  }
  const port = Number.parseInt(portText, 10);
  if (port < 0 || port > 65535 || host.length === 0) {
    throw new RelayConfigError({ message: `Bind address out of range: ${rawBind}` });
  }
  return { host, port };
}
