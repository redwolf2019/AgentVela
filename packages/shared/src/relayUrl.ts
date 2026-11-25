import { RELAY_ENDPOINT_KEY_PATTERN } from "@t3tools/contracts/agentVelaRelay";

import {
  isLocalLoopbackHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
  normalizeHostname,
} from "./hostClassification.ts";

export type RelayUrlTransport = "https" | "http_loopback" | "http_lan" | "http_tailnet";

export interface ParsedRelayUrl {
  readonly origin: string;
  readonly wsOrigin: string;
  readonly transport: RelayUrlTransport;
  readonly insecure: boolean;
}

export interface DerivedRelayEnvironmentEndpoints {
  readonly endpointKey: string;
  readonly pathPrefix: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

function parseDottedIpv4(host: string): readonly number[] | null {
  const parts = host.split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function extractIpv4Parts(hostname: string): readonly number[] | null {
  const normalized = normalizeHostname(hostname);
  if (normalized.startsWith("::ffff:")) {
    const suffix = normalized.slice("::ffff:".length);
    const dotted = parseDottedIpv4(suffix);
    if (dotted !== null) return dotted;
    const hextets = suffix.split(":");
    if (hextets.length !== 2 || hextets.some((part) => !/^[\da-f]{1,4}$/u.test(part))) {
      return null;
    }
    const high = Number.parseInt(hextets[0]!, 16);
    const low = Number.parseInt(hextets[1]!, 16);
    return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
  }
  return parseDottedIpv4(normalized);
}

function isRfc1918Ipv4(parts: readonly number[]): boolean {
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function classifyHttpHostTransport(hostname: string): Exclude<RelayUrlTransport, "https"> | null {
  const normalized = normalizeHostname(hostname);
  const ipv4 = extractIpv4Parts(hostname);

  if (
    isLocalLoopbackHost(hostname) ||
    normalized.endsWith(".localhost") ||
    (ipv4 !== null && ipv4[0] === 127)
  ) {
    return "http_loopback";
  }

  if (
    isTailnetHost(hostname) ||
    isSharedAddressSpaceHost(hostname) ||
    (ipv4 !== null && ipv4[0] === 100 && ipv4[1]! >= 64 && ipv4[1]! <= 127)
  ) {
    return "http_tailnet";
  }

  if (ipv4 !== null && isRfc1918Ipv4(ipv4)) {
    return "http_lan";
  }

  return null;
}

function parseRootRelayOrigin(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    if (
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      !/^\/+$/u.test(url.pathname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function normalizeSecureRelayUrl(value: string): string | null {
  const url = parseRootRelayOrigin(value);
  return url !== null && url.protocol === "https:" ? url.origin : null;
}

export function isSecureRelayUrl(value: string): boolean {
  return normalizeSecureRelayUrl(value) !== null;
}

export function parseRelayUrl(value: string): ParsedRelayUrl | null {
  const url = parseRootRelayOrigin(value);
  if (url === null) return null;

  if (url.protocol === "https:") {
    return {
      origin: url.origin,
      wsOrigin: `wss://${url.host}`,
      transport: "https",
      insecure: false,
    };
  }

  if (url.protocol !== "http:") {
    return null;
  }

  const transport = classifyHttpHostTransport(url.hostname);
  if (transport === null) return null;

  return {
    origin: url.origin,
    wsOrigin: `ws://${url.host}`,
    transport,
    insecure: true,
  };
}

export function normalizeRelayUrl(value: string): string | null {
  return parseRelayUrl(value)?.origin ?? null;
}

export function deriveRelayEnvironmentEndpoints(
  relayUrl: string,
  endpointKey: string,
): DerivedRelayEnvironmentEndpoints | null {
  const parsed = parseRelayUrl(relayUrl);
  if (parsed === null || !RELAY_ENDPOINT_KEY_PATTERN.test(endpointKey)) {
    return null;
  }
  const pathPrefix = `/e/${endpointKey}`;
  return {
    endpointKey,
    pathPrefix,
    httpBaseUrl: `${parsed.origin}${pathPrefix}`,
    wsBaseUrl: `${parsed.wsOrigin}${pathPrefix}`,
  };
}

function hasUnsafePathSegments(pathname: string): boolean {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return true;
  if (pathname.includes("\\") || pathname.includes("?") || pathname.includes("#")) return true;

  for (const segment of pathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === ".." || decoded === "." || decoded.includes("/") || decoded.includes("\\")) {
      return true;
    }
  }
  return false;
}

export function joinEndpointUrl(baseUrl: string, pathname: string): string {
  if (hasUnsafePathSegments(pathname)) {
    throw new Error(`Invalid endpoint pathname: ${pathname}`);
  }
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
