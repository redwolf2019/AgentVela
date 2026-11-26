# Self-Hosted Network Hardening

AgentVela defaults to a fail-closed network posture so self-hosted, LAN, Tailscale, and air-gapped deployments do not send pairing tokens, internal URLs, or telemetry to upstream hosted services.

## Default Privacy Posture

- **No hosted web fallback**: Missing `T3CODE_HOSTED_APP_URL` / `VITE_HOSTED_APP_URL` stops hosted pairing links and cross-surface redirects instead of falling back to `app.t3.codes`.
- **Background provider checks disabled**: `enableProviderUpdateChecks` defaults to `false`, disabling startup and periodic Model Manifest fetches, npm/upstream CLI update checks, ACP Registry background refreshes, and automatic Codex binary upgrades.
- **No external favicon proxy**: External links render without calling `www.google.com/s2/favicons`, and external images/icons send `referrerPolicy="no-referrer"`.
- **Mobile OTA disabled**: `u.expo.dev` EAS updates stay off unless `T3CODE_MOBILE_UPDATES_ENABLED=1` is paired with an explicit `T3CODE_MOBILE_UPDATES_URL` or `T3CODE_MOBILE_EAS_PROJECT_ID`.
- **Third-party MCP disclosure**: One-click MCP links that embed the environment URL in query parameters (`Poke`, `Claude`) disclose the target host and require explicit confirmation.

## Environment Overrides and Mirrors

HTTPS mirror URLs (or `http://` on loopback hosts) are validated fail-closed. Setting a `*_URL` mirror variable to `off`, `none`, or `disabled` stops network fetches for that feature completely.

| Feature                     | Variable                                                                                     | Default                                                                                                     | Notes                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Hosted Web origin (Server)  | `T3CODE_HOSTED_APP_URL`                                                                      | Unset (disabled)                                                                                            | Required only for hosted OAuth / cross-origin redirects                       |
| Hosted Web origin (Web)     | `VITE_HOSTED_APP_URL`                                                                        | Unset (current origin)                                                                                      | Pairing QR links fall back only to local `window.location.origin`             |
| CLI & SSH binary releases   | `T3CODE_RELEASE_BASE_URL`                                                                    | `https://github.com/redwolf2019/AgentVela/releases/download`                                                | Used by SSH remote bootstrap (`off` blocked via `ManagedPolicy`)              |
| Desktop update repository   | `T3CODE_DESKTOP_UPDATE_REPOSITORY`                                                           | `redwolf2019/AgentVela`                                                                                     | Format: `<owner>/<repo>`                                                      |
| ACP Registry index & icons  | `T3CODE_ACP_REGISTRY_URL`                                                                    | `https://cdn.agentclientprotocol.com/registry/v1/latest`                                                    | Supports custom mirror or `off`                                               |
| Model manifest              | `T3CODE_MODEL_MANIFEST_URL`                                                                  | `https://raw.githubusercontent.com/redwolf2019/AgentVela/main/apps/server/src/provider/model-manifest.json` | Supports mirror or `off`; falls back to bundled manifest                      |
| Preview Chrome binary / CDN | `T3CODE_CHROME_EXECUTABLE_PATH`, `T3CODE_CHROME_HEADLESS_BASE_URL`                           | System Chrome / Google CFT CDN                                                                              | `BASE_URL=off` disables downloads; `EXECUTABLE_PATH` uses preinstalled Chrome |
| Local Speech GGUF models    | `T3CODE_SPEECH_MODEL_BASE_URL`                                                               | `https://huggingface.co`                                                                                    | Supports mirror or `off` (local linking still works)                          |
| Open VSX theme marketplace  | `VITE_OPEN_VSX_BASE_URL`                                                                     | `https://open-vsx.org`                                                                                      | Web build/runtime mirror URL or `off`                                         |
| Bug triage source clone     | `T3CODE_TRIAGE_REPOSITORY_URL`                                                               | `https://github.com/redwolf2019/AgentVela`                                                                  | Supports internal Git URL or `off`                                            |
| Mobile EAS OTA              | `T3CODE_MOBILE_UPDATES_ENABLED`, `T3CODE_MOBILE_UPDATES_URL`, `T3CODE_MOBILE_EAS_PROJECT_ID` | Disabled                                                                                                    | Enable only with self-hosted update server or explicit EAS project            |
| Auto-update & OTLP shutdown | `T3CODE_DISABLE_AUTO_UPDATE=1`, `T3CODE_OTEL_SDK_DISABLED=true`                              | Active per config                                                                                           | Disables desktop updater checks and OTLP SDK export                           |

## Managed Policy Enforcement

Enterprise `ManagedPolicy` enforces offline and privacy restrictions across subsystems:

- `limits.telemetry: false`: drops trace/metric spans, log exports, `/api/otlp/v1/traces` proxy requests, and OTLP endpoint check probes with HTTP 403 (`Rejected`) before making outbound requests.
- `limits.updates.mode: "off"`: blocks both Desktop app auto-updates and Desktop SSH remote CLI archive downloads, while continuing to allow preinstalled `t3` on the remote host.
- `limits.updates.feedUrl`: overrides both Desktop updates and SSH CLI archive downloads.

## Air-Gapped Baseline Example

```sh
export T3CODE_DISABLE_AUTO_UPDATE=1
export T3CODE_OTEL_SDK_DISABLED=true
export T3CODE_ACP_REGISTRY_URL=off
export T3CODE_MODEL_MANIFEST_URL=off
export T3CODE_CHROME_HEADLESS_BASE_URL=off
export T3CODE_SPEECH_MODEL_BASE_URL=off
export T3CODE_TRIAGE_REPOSITORY_URL=off
export VITE_OPEN_VSX_BASE_URL=off
```
