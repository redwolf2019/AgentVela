# Install AgentVela

AgentVela runs coding agents on your computer and lets you control them from its desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider CLI before starting a thread, or you can launch AgentVela first and configure providers afterwards.

Prebuilt releases are published on [`redwolf2019/AgentVela` GitHub Releases](https://github.com/redwolf2019/AgentVela/releases/latest) for Desktop (macOS arm64 DMG, Linux x64/arm64 AppImage & `.deb`, Windows x64 NSIS), Server CLI archives, and Android (`arm64-v8a` APK).

## Install prebuilt binaries

### CLI & background service (`t3`)

```bash
curl -fsSL https://github.com/redwolf2019/AgentVela/releases/latest/download/install.sh | sh
# Windows PowerShell: irm https://github.com/redwolf2019/AgentVela/releases/latest/download/install.ps1 | iex
```

Both installers verify `SHA256SUMS` against `release-manifest.json` before installing `t3`, and honor `T3CODE_RELEASE_BASE_URL` for custom mirrors.

## Build from source

Install Vite+ and clone the repository:

```bash
curl -fsSL https://vite.plus | bash
# Windows PowerShell: irm https://vite.plus/ps1 | iex

git clone https://github.com/redwolf2019/AgentVela.git
cd AgentVela
vp i
vp run dev
```

_(On Windows, clone with `git clone -c core.longpaths=true https://github.com/redwolf2019/AgentVela.git`.)_

Open the pairing URL printed in the terminal to authenticate your browser session. Use `vp run dev:desktop` to run the Electron desktop app, or see the [development runbook](../operations/00_development.md#first-checkout) for local desktop installers (`vp run dist:desktop:dmg`, `vp run dist:desktop:linux`, `vp run dist:desktop:win`).

## Command line

Once built or installed locally, the `t3` command manages the local server, relay linking, and background service:

| Task                                  | Command                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Start the server and open the web app | `t3`                                                                    |
| Start the server without a browser    | `t3 serve`                                                              |
| Use it from your other devices        | `t3 up` ([details](./remote-access.md))                                 |
| Keep it running in the background     | `t3 service install` ([details](./background-service.md))               |
| Reclaim database space                | `t3 doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove the background service         | `t3 uninstall`                                                          |

Run `t3 help` or `t3 --help` for the full reference. To start in a new working directory, pass an explicit path such as `t3 ./my-project`.

If `t3` or `t3 start` reports an already running server, run the `t3 pair` command it names and open the pairing URL to connect to that server. Stop it before starting a replacement, or use a different `--base-dir` for an independent server.

### The `t3` command

Desktop builds include the `t3` command-line tool. A new install sets it up on first launch; after an update, or any time, choose **Install** next to **t3 command** in **Settings → About**. On macOS and Linux it adds a `t3` link in `~/.local/bin` (or `~/bin`); on Windows it adds the app's command folder to your `PATH`. Open a new terminal afterwards. If the folder is not on your `PATH`, **Add to PATH** on the Welcome page or in **Settings → About** adds one line to your shell's startup file. **Remove** takes it off, and the app does not add it again. If you already have another `t3`, it leaves that file untouched.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects there. Install the provider CLIs inside that distro. AgentVela installs its own server runtime there automatically; the first launch after an app update can take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed. Pass a path, such as `t3 app ../my-project`, to open another directory. It requires the desktop app, so a standalone server or an SSH session is not enough. If the command cannot reach the app, start or update the desktop app and try again.

### Drop a folder on the sidebar

Drag one or more folders from Finder, Explorer, or your file manager onto the sidebar. Each one opens as a project on this computer, the same as `t3 app`. Files dropped on a thread still attach to that thread. Browsers do not share folder paths, so in the web app use **Add project** instead.

## Mobile app

The React Native mobile client connects to an AgentVela server over LAN, Tailscale, or a [self-hosted relay](./remote-access.md).

Install the signed Android APK (`AgentVela-<version>-android-arm64-v8a.apk`) from [`redwolf2019/AgentVela` GitHub Releases](https://github.com/redwolf2019/AgentVela/releases/latest) and update in-app via **Settings → About → Updates** (or build iOS/Android from source using [apps/mobile/README.md](../../apps/mobile/README.md)).

If the app crashes during launch, open **Settings → Diagnostics** on the next launch that succeeds. It lists startup crashes from the last 7 days with the error and component stack. Copy the report and paste it into a GitHub issue after redacting any local paths or secrets.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment, and enable the provider you want. Installation, login, and configuration belong to that environment's machine, even when you connect from a phone or another computer.

| Provider            | Install and authenticate                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex               | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude              | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor              | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build          | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro                | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode            | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity         | Install and sign in with Google from AgentVela's provider settings.                                                                                       |
| Pi                  | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code           | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx                  | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |
| ACP Registry agents | Add GitHub Copilot and other [ACP agents](./providers-acp.md#add-an-agent) from **Settings → Providers → Add provider → Show more**.                      |

Provider CLIs must be on the server's `PATH`. If AgentVela cannot find one, set its **Binary path** in provider settings, especially when using a version manager. Cursor's executable is `cursor-agent`, although its login command is `agent login`. Codex connected through ChatGPT and Antigravity can use their managed runtimes without a `PATH` entry.

AgentVela warns when a provider version has known compatibility problems with your release. Check **Settings → Providers** on that environment for the recommended version or range. When its package manager supports installing a specific version, you can install the recommendation there. Otherwise use the provider's installer on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the available version. **Update now** runs the installer that owns the CLI (Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the CLI's own update command when AgentVela cannot tell. Claude, Codex, and OpenCode installs AgentVela cannot identify stay manual: update them through the installer you used. AgentVela runs `mise upgrade` only for a tool your mise config requests as `latest` when the provider's binary path is a mise shim or under the tool's `installs/<tool>/latest` link; update a pinned version, or a path into one version's directory, through mise yourself. Update a CLI installed with Nix through Nix. Cursor and Antigravity update with AgentVela. Homebrew and Chocolatey installs compare against the version their package manager offers, which can trail the npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT first install the release AgentVela tested. When AgentVela finds a newer compatible release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each instance can have its own environment variables, such as API keys or a custom base URL. Mark secret values as sensitive; after saving, AgentVela does not display their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md), [Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), [Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md), [Pi](./providers-pi.md), [Muse Code](./providers-muse.md), [fx](./providers-fx.md), and [ACP Registry agents](./providers-acp.md).

### Provider check timeouts

If a provider works in its CLI but AgentVela reports a timeout while checking it, allow more time in the AgentVela server's environment. For example, give Codex and Claude readiness checks 60 seconds:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 t3 serve
```

For a remote environment, set these on the machine running the AgentVela server. Keep them in your launcher or service configuration to retain them across updates, then restart the server. For systemd, add `Environment=T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service override, reload systemd, and restart the service. Provider instances can also set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose default is already longer keeps its default. Providers with several phases can take longer than one deadline in total. Values must be whole milliseconds no greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                   |
| ------------------- | -------------------------------------- |
| Codex               | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor              | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity         | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok                | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro                | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx                  | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi                  | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code           | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides cover readiness and discovery, including OpenCode server startup. Config enrichment retains its own shorter limits. Turn execution, package installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating AgentVela](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure AgentVela for everyone on a machine.
