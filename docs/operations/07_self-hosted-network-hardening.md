# Self-Hosted Network Hardening

AgentVela defaults to a fail-closed network posture so self-hosted, LAN, Tailscale, and air-gapped deployments do not send pairing tokens, internal URLs, or telemetry to upstream hosted services.

## Default Privacy Posture

- **No hosted web fallback**: Missing `T3CODE_HOSTED_APP_URL` / `VITE_HOSTED_APP_URL` stops hosted pairing links and cross-surface redirects instead of falling back to `app.t3.codes`.
- **Self-hosted release updates only**: Desktop, Server CLI, `install.sh`/`install.ps1`, and Android read `<base>/latest/download/release-manifest.json` from `https://github.com/redwolf2019/AgentVela/releases` (or configured mirror) without hitting GitHub REST API quotas or upstream npm/EAS endpoints, and require SHA-256 verification before installing.
- **Background provider checks disabled**: `enableProviderUpdateChecks` defaults to `false`, disabling startup and periodic Model Manifest fetches, provider CLI update checks, ACP Registry background refreshes, and automatic Codex binary upgrades.
- **No external favicon proxy**: External links render without calling `www.google.com/s2/favicons`, and external images/icons send `referrerPolicy="no-referrer"`.
- **Expo OTA disabled**: `expo-updates` is permanently disabled (`enabled: false`) across all mobile variants. Android release builds use the native signed APK updater; iOS update checks remain disabled.
- **Third-party MCP disclosure**: One-click MCP links that embed the environment URL in query parameters (`Poke`, `Claude`) disclose the target host and require explicit confirmation.

## Release Mirror Precedence & Overrides

All update surfaces (Desktop, Server auto-check & self-update, `t3 update`, `install.sh` / `install.ps1`, and Android/Mobile environment checks) resolve their release base URL in strict fail-closed order:

1. `ManagedPolicy.limits.updates.feedUrl` (enterprise policy override; highest priority)
2. `T3CODE_RELEASE_BASE_URL` environment variable (CLI/server/installer override)
3. User UI setting (`updateMirrorUrl` in Desktop settings, Server settings, or Mobile preferences)
4. Default: `https://github.com/redwolf2019/AgentVela/releases`

Any invalid override rejects the update check cleanly instead of silently falling back. Only `https://` URLs and loopback `http://` hosts (`localhost`, `127.0.0.1`, `::1`) are accepted. Setting `feedUrl` / `T3CODE_RELEASE_BASE_URL` to `off`, `none`, or `disabled` halts release fetches completely.

| Feature                     | Variable                                                           | Default                                                                                                     | Notes                                                                         |
| --------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Hosted Web origin (Server)  | `T3CODE_HOSTED_APP_URL`                                            | Unset (disabled)                                                                                            | Required only for hosted OAuth / cross-origin redirects                       |
| Hosted Web origin (Web)     | `VITE_HOSTED_APP_URL`                                              | Unset (current origin)                                                                                      | Pairing QR links fall back only to local `window.location.origin`             |
| Unified Release Mirror      | `T3CODE_RELEASE_BASE_URL`                                          | `https://github.com/redwolf2019/AgentVela/releases`                                                         | Serves `release-manifest.json`, assets, and `SHA256SUMS`; `off` disables      |
| ACP Registry index & icons  | `T3CODE_ACP_REGISTRY_URL`                                          | `https://cdn.agentclientprotocol.com/registry/v1/latest`                                                    | Supports custom mirror or `off`                                               |
| Model manifest              | `T3CODE_MODEL_MANIFEST_URL`                                        | `https://raw.githubusercontent.com/redwolf2019/AgentVela/main/apps/server/src/provider/model-manifest.json` | Supports mirror or `off`; falls back to bundled manifest                      |
| Preview Chrome binary / CDN | `T3CODE_CHROME_EXECUTABLE_PATH`, `T3CODE_CHROME_HEADLESS_BASE_URL` | System Chrome / Google CFT CDN                                                                              | `BASE_URL=off` disables downloads; `EXECUTABLE_PATH` uses preinstalled Chrome |
| Local Speech GGUF models    | `T3CODE_SPEECH_MODEL_BASE_URL`                                     | `https://huggingface.co`                                                                                    | Supports mirror or `off` (local linking still works)                          |
| Open VSX theme marketplace  | `VITE_OPEN_VSX_BASE_URL`                                           | `https://open-vsx.org`                                                                                      | Web build/runtime mirror URL or `off`                                         |
| Bug triage source clone     | `T3CODE_TRIAGE_REPOSITORY_URL`                                     | `https://github.com/redwolf2019/AgentVela`                                                                  | Supports internal Git URL or `off`                                            |
| Auto-update & OTLP shutdown | `T3CODE_DISABLE_AUTO_UPDATE=1`, `T3CODE_OTEL_SDK_DISABLED=true`    | Active in release builds                                                                                    | Disables desktop & server release update checks and OTLP SDK export           |

## Managed Policy Enforcement

Enterprise `ManagedPolicy` enforces offline and privacy restrictions across subsystems:

- `limits.telemetry: false`: drops trace/metric spans, log exports, `/api/otlp/v1/traces` proxy requests, and OTLP endpoint check probes with HTTP 403 (`Rejected`) before making outbound requests.
- `limits.updates.mode: "off"`: blocks Desktop app updates, Server release checks/self-updates, and Desktop SSH remote CLI archive downloads, while continuing to allow preinstalled `t3` on the remote host.
- `limits.updates.feedUrl`: overrides the release base URL across Desktop updates, Server release checks/self-updates, and SSH CLI archive downloads (takes precedence over `T3CODE_RELEASE_BASE_URL` and UI mirror settings).

## Air-Gapped Baseline Example

```sh
export T3CODE_DISABLE_AUTO_UPDATE=1
export T3CODE_OTEL_SDK_DISABLED=true
export T3CODE_RELEASE_BASE_URL=off
export T3CODE_ACP_REGISTRY_URL=off
export T3CODE_MODEL_MANIFEST_URL=off
export T3CODE_CHROME_HEADLESS_BASE_URL=off
export T3CODE_SPEECH_MODEL_BASE_URL=off
export T3CODE_TRIAGE_REPOSITORY_URL=off
export VITE_OPEN_VSX_BASE_URL=off
```
