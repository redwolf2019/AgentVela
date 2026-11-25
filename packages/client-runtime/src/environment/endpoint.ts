import { RELAY_ENDPOINT_KEY_PATTERN } from "@t3tools/contracts/agentVelaRelay";
import { joinEndpointUrl } from "@t3tools/shared/relayUrl";

export * from "@t3tools/shared/advertisedEndpoint";

export function extractRelayEndpointPathPrefix(pathname: string): string | null {
  const match = /^\/e\/([^/]+)(?:\/|$)/u.exec(pathname);
  if (!match || !RELAY_ENDPOINT_KEY_PATTERN.test(match[1]!)) {
    return null;
  }
  return `/e/${match[1]!}`;
}

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string =>
  joinEndpointUrl(httpBaseUrl, pathname);

export function environmentEndpointRelativeUrl(
  httpBaseUrl: string,
  relativeOrAbsoluteUrl: string,
): string {
  if (
    /^[a-z][a-z0-9+.-]*:/iu.test(relativeOrAbsoluteUrl) ||
    relativeOrAbsoluteUrl.startsWith("//")
  ) {
    return new URL(relativeOrAbsoluteUrl, httpBaseUrl).toString();
  }
  const base = new URL(httpBaseUrl);
  const basePath = base.pathname.replace(/\/+$/u, "");
  if (relativeOrAbsoluteUrl.startsWith("/")) {
    const parsed = new URL(relativeOrAbsoluteUrl, "http://endpoint.invalid");
    const hasPrefix =
      basePath.length > 0 &&
      (parsed.pathname === basePath || parsed.pathname.startsWith(`${basePath}/`));
    const joined = hasPrefix
      ? (() => {
          const out = new URL(httpBaseUrl);
          out.pathname = parsed.pathname;
          return out;
        })()
      : new URL(joinEndpointUrl(httpBaseUrl, parsed.pathname));
    joined.search = parsed.search;
    joined.hash = parsed.hash;
    return joined.toString();
  }
  base.pathname = `${basePath}/`;
  return new URL(relativeOrAbsoluteUrl, base).toString();
}

export function environmentRpcSocketUrl(wsBaseUrl: string): URL {
  const url = new URL(wsBaseUrl);
  const trimmed = url.pathname.replace(/\/+$/u, "");
  if (trimmed === "") {
    url.pathname = "/ws";
  } else if (trimmed.endsWith("/ws")) {
    url.pathname = trimmed;
  } else if (extractRelayEndpointPathPrefix(trimmed) === trimmed) {
    url.pathname = `${trimmed}/ws`;
  }
  return url;
}

export function stripEndpointPathSuffix(fullUrl: string, suffixPathname: string): string {
  const url = new URL(fullUrl);
  url.search = "";
  url.hash = "";
  const suffix = suffixPathname.replace(/\/+$/u, "");
  const path = url.pathname.replace(/\/+$/u, "");
  if (suffix.length > 0 && path.endsWith(suffix)) {
    const remaining = path.slice(0, -suffix.length);
    url.pathname = remaining.length === 0 ? "/" : remaining;
  }
  return url.toString();
}
