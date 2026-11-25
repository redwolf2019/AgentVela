<div align="center">

# AgentVela

**An open-source, cross-platform command center for AI coding agents.**

Run, orchestrate, and control multiple coding agents across local and remote machines through one fast, unified interface.

**English** · [简体中文](./README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Status: Active Fork](https://img.shields.io/badge/Status-Independent%20Fork-orange.svg)](#attribution--acknowledgments)
[![Issues](https://img.shields.io/github/issues/redwolf2019/AgentVela)](https://github.com/redwolf2019/AgentVela/issues)

</div>

> [!NOTE]
> **AgentVela** is an independent, unofficial open-source project forked from the MIT-licensed source code of T3 Code. It is not affiliated with, endorsed by, or maintained by T3 Tools, Inc. See [Attribution & Acknowledgments](#attribution--acknowledgments).

## Overview

AgentVela runs local and remote coding agents behind a single Node WebSocket control plane and gives them a unified interface across desktop, web, and mobile. Start a task at your desk, switch models or agents mid-thread, review diffs in isolated Git worktrees, and keep working from another machine or phone.

It supports **Claude Code**, **Codex**, **Cursor**, **OpenCode**, **Grok Build**, **Antigravity**, **Kiro**, **Pi**, **Muse Code**, **fx**, and any [ACP (Agent Client Protocol)](./docs/user/providers-acp.md) agent installed on your machine.

## Features

- **Bring your own subscriptions.** AgentVela does not resell tokens—it drives the agent CLIs and accounts you are already signed in to.
- **Multi-agent workspace.** Manage multiple coding agents in one place, switch models mid-thread, and hand off work between agents.
- **Cross-platform architecture.** Built as a shared server powering Desktop (Electron), Web (React/Vite), and Mobile (React Native) clients over WebSockets.
- **Self-hosted & remote ready.** Run agents on any machine and connect over your local network, SSH, Tailscale, or your own relay setup.
- **Git built in.** Run threads in isolated Git worktrees, inspect diffs, and handle commits, pushes, and pull requests directly from the UI.
- **Extensible via ACP & MCP.** Plug in any ACP-compatible agent or connect external agents and tools over MCP.
- **Performance focused.** Designed for low-latency streaming, bounded wire payloads, and smooth rendering even under heavy agent output.

## Project Status & Roadmap

AgentVela is in early independent development. Right now, the repository builds and runs directly from source while we establish AgentVela's own direction and infrastructure.

Near-term priorities:

- **Brand & identity.** Dedicated AgentVela icons, visual assets, and fully updated documentation.
- **Distribution & releases.** Prebuilt desktop installers (macOS, Windows, Linux) and standalone CLI releases via GitHub Releases.
- **Self-hosted first.** Streamlined self-hosted remote workflows with zero proprietary cloud dependencies.
- **Multi-agent orchestration.** Deeper workflow automation and cross-agent coordination tailored to AgentVela's roadmap.

## Getting Started (From Source)

Prebuilt releases are not published yet. You can run AgentVela locally from source today.

### 1. Prerequisites

Install [Vite+](https://viteplus.dev/guide/) (`vp` automatically manages the pinned Node.js toolchain from `package.json`):

```bash
curl -fsSL https://vite.plus | bash
```

On Windows (PowerShell):

```powershell
irm https://vite.plus/ps1 | iex
```

You also need at least one coding agent CLI installed and authenticated on your machine—for example, [Claude Code](https://claude.com/product/claude-code) (`claude auth login`) or [Codex CLI](https://developers.openai.com/codex/cli) (`codex login`).

### 2. Clone and install dependencies

```bash
git clone https://github.com/redwolf2019/AgentVela.git
cd AgentVela
vp i
```

_(On Windows, clone with `git clone -c core.longpaths=true https://github.com/redwolf2019/AgentVela.git`.)_

### 3. Run in development mode

Start the local server and web app:

```bash
vp run dev
```

Open the pairing URL printed in the terminal to authenticate your browser session.

Other launch targets:

- **Desktop (Electron):** `vp run dev:desktop`
- **Share over Tailscale:** `vp run dev --share`
- **Mobile (React Native):** see [apps/mobile/README.md](./apps/mobile/README.md)

### 4. Build local desktop packages (optional)

Unsigned local installers are written to `release/`:

```bash
vp run dist:desktop:dmg    # macOS
vp run dist:desktop:linux  # Linux AppImage
vp run dist:desktop:win    # Windows NSIS
```

See the [development runbook](./docs/operations/00_development.md) for platform build prerequisites and advanced options.

## Documentation

> Some documents under `docs/` are inherited from upstream and are being progressively updated for AgentVela.

- [Development & local builds](./docs/operations/00_development.md)
- [Architecture overview](./docs/internals/01_architecture.md)
- [ACP providers](./docs/user/providers-acp.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control & worktrees](./docs/user/source-control.md)
- [Remote access](./docs/user/remote-access.md)
- [Outside agents (MCP)](./docs/user/outside-agents.md)
- [All docs](./docs/README.md)

## Contributing

Contributions, bug reports, and ideas are welcome:

- Open a bug report or feature proposal in [GitHub Issues](https://github.com/redwolf2019/AgentVela/issues).
- Follow the [development runbook](./docs/operations/00_development.md) to set up a local checkout and run checks (`vp run check:changed`) before submitting a pull request.

## License

The source code in this repository is licensed under the [MIT License](./LICENSE).

## Attribution & Acknowledgments

AgentVela is an **independent, unofficial fork** derived from the MIT-licensed source code of [T3 Code](https://github.com/pingdotgg/t3code). AgentVela is **not affiliated with, endorsed by, or maintained by T3 Tools, Inc.** All T3 Code names, logos, and trademarks remain the property of T3 Tools, Inc.

We are deeply grateful to the T3 Code maintainers and open-source contributors for building such a clean, fast, and thoughtfully engineered foundation and sharing it openly with the community under the MIT License. AgentVela exists because of their generosity and commitment to open source.
