import type * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

/** The home Pi resolves `~` against: the instance's HOME (USERPROFILE on Windows), else the host's. */
export function piHome(
  environment: NodeJS.ProcessEnv,
  hostHome: string,
  platform: NodeJS.Platform,
): string {
  return (platform === "win32" ? environment.USERPROFILE : environment.HOME) || hostHome;
}

/** Where Pi stores session JSONL files for a provider environment, matching Pi's own lookup. */
export function resolvePiSessionsDir(
  environment: NodeJS.ProcessEnv,
  home: string,
  path: Path.Path,
): string {
  const sessionDir = environment.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionDir) return path.resolve(expandHomePath(sessionDir, home));
  const agentDir = environment.PI_CODING_AGENT_DIR?.trim();
  return path.resolve(
    agentDir ? expandHomePath(agentDir, home) : path.join(home, ".pi", "agent"),
    "sessions",
  );
}
