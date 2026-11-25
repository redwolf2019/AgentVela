import { RELAY_ENDPOINT_KEY_PATTERN } from "@t3tools/contracts/agentVelaRelay";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

const LOOPBACK_IPV4_RE =
  /^127\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const UNSAFE_HOST_RE = /[\s/@?#\u0000-\u001f\u007f]/u;

function firstHeaderValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = value.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

function readPeerAddress(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const source = request.source;
  if (!source || typeof source !== "object") return undefined;
  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: { readonly remoteAddress?: string | null };
  };
  const raw = candidate.socket?.remoteAddress ?? candidate.remoteAddress;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

/**
 * True when the underlying TCP peer is loopback (local reverse proxy / tunnel forwarder) or when
 * no socket metadata is attached (in-memory test requests).
 */
function isLoopbackProxyPeer(request: HttpServerRequest.HttpServerRequest): boolean {
  const peer = readPeerAddress(request);
  if (peer === undefined) return true;
  return LOOPBACK_IPV4_RE.test(peer) || peer === "::1";
}

export function trustedForwardedPrefix(request: HttpServerRequest.HttpServerRequest): string {
  if (!isLoopbackProxyPeer(request)) return "";
  const prefix = firstHeaderValue(request.headers["x-forwarded-prefix"]);
  if (prefix === undefined || !prefix.startsWith("/e/")) return "";
  const key = prefix.slice("/e/".length);
  return RELAY_ENDPOINT_KEY_PATTERN.test(key) ? prefix : "";
}

function trustedForwardedHost(request: HttpServerRequest.HttpServerRequest): string | undefined {
  if (!isLoopbackProxyPeer(request)) return undefined;
  const host = firstHeaderValue(request.headers["x-forwarded-host"]);
  return host !== undefined && !UNSAFE_HOST_RE.test(host) ? host : undefined;
}

/**
 * `HttpServerRequest.toURL` that honors `X-Forwarded-Proto: https`. Effect 4.1
 * stopped reading it, but TLS-terminating proxies in front of the server
 * (Tailscale Serve, tunnels) rely on it for OAuth, DPoP and pairing URLs.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> =>
  HttpServerRequest.toURL(
    request.headers["x-forwarded-proto"] === "https" && request.protocol !== "https"
      ? request.modify({ protocol: "https" })
      : request,
  );

/**
 * External client-facing URL combining `requestUrl` with validated `X-Forwarded-Host`,
 * `X-Forwarded-Proto`, and `X-Forwarded-Prefix` (`/e/<endpointKey>`) when coming from a loopback
 * proxy peer.
 */
export const externalRequestUrl = (
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<URL> =>
  Option.map(requestUrl(request), (internalUrl) => {
    if (!isLoopbackProxyPeer(request)) {
      return internalUrl;
    }
    const rawProto = firstHeaderValue(request.headers["x-forwarded-proto"])?.toLowerCase();
    const proto =
      rawProto === "http" || rawProto === "https"
        ? rawProto
        : internalUrl.protocol.replace(/:$/u, "");
    const host = trustedForwardedHost(request) ?? internalUrl.host;
    let url: URL;
    try {
      url = new URL(`${proto}://${host}`);
    } catch {
      return internalUrl;
    }
    const prefix = trustedForwardedPrefix(request);
    const rawPath = internalUrl.pathname;
    url.pathname =
      prefix !== "" && rawPath !== prefix && !rawPath.startsWith(`${prefix}/`)
        ? `${prefix}${rawPath.startsWith("/") ? rawPath : `/${rawPath}`}`
        : rawPath;
    url.search = internalUrl.search;
    url.hash = internalUrl.hash;
    return url;
  });
