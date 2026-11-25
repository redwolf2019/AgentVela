// @effect-diagnostics nodeBuiltinImport:off -- Static Web UI server reads local dist assets via Node fs/path.
import * as NodeFSP from "node:fs/promises";
import type * as NodeHttp from "node:http";
import * as NodePath from "node:path";

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function resolveDefaultWebUiDir(): string {
  return NodePath.resolve(import.meta.dirname, "../../../web/dist");
}

function resolveSafeAssetPath(rootDir: string, urlPathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const resolvedRoot = NodePath.resolve(rootDir);
  const candidate = NodePath.resolve(resolvedRoot, relative);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${NodePath.sep}`)) {
    return null;
  }
  return candidate;
}

async function readRegularFile(filePath: string): Promise<Buffer | null> {
  try {
    const stat = await NodeFSP.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return await NodeFSP.readFile(filePath);
  } catch {
    return null;
  }
}

const RELAY_HOSTED_META_TAG = '<meta name="agent-vela-relay-hosted" content="1" />';

function injectRelayHostedMarker(html: string): string {
  if (html.includes('name="agent-vela-relay-hosted"')) {
    return html;
  }
  if (html.includes("</head>")) {
    return html.replace("</head>", `${RELAY_HOSTED_META_TAG}</head>`);
  }
  return `${RELAY_HOSTED_META_TAG}${html}`;
}

export async function tryServeStaticWebUi(
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
  webUiDir: string,
): Promise<boolean> {
  const method = req.method?.toUpperCase() ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }
  const rawUrl = req.url ?? "/";
  const pathname = rawUrl.split("?", 1)[0] ?? "/";
  const safePath = resolveSafeAssetPath(webUiDir, pathname === "/" ? "/index.html" : pathname);
  if (!safePath) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "bad_request", message: "Invalid path" }));
    return true;
  }

  let targetPath = safePath;
  let content = await readRegularFile(targetPath);
  if (!content && !pathname.startsWith("/assets/")) {
    targetPath = NodePath.join(NodePath.resolve(webUiDir), "index.html");
    content = await readRegularFile(targetPath);
  }
  if (!content) {
    return false;
  }

  const ext = NodePath.extname(targetPath).toLowerCase();
  const payload =
    ext === ".html"
      ? Buffer.from(injectRelayHostedMarker(content.toString("utf8")), "utf8")
      : content;
  const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const cacheControl =
    pathname.startsWith("/assets/") && targetPath !== NodePath.join(webUiDir, "index.html")
      ? "public, max-age=31536000, immutable"
      : "no-cache";

  res.writeHead(200, {
    "content-type": contentType,
    "content-length": String(payload.byteLength),
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
  });
  res.end(method === "HEAD" ? undefined : payload);
  return true;
}
