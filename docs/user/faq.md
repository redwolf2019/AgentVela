# FAQ

## Is AgentVela an agent harness?

No. AgentVela is the control plane and UI over existing coding agent CLIs and runtimes (such as Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and ACP agents). Each provider handles its own model calls, tools, and execution loop while AgentVela manages threads, worktrees, diffs, permissions, and multi-device access. [Provider setup](./install.md#providers)

## Can I use AgentVela with my existing subscriptions?

Yes. Bring your own agent subscriptions or API keys. AgentVela runs the CLIs and accounts already signed in on your host machine and never resells tokens.

## How much does AgentVela cost?

AgentVela is free and open-source under the [MIT License](../../LICENSE). You pay only your chosen AI providers directly, and if you deploy [`agent-vela-relay`](../../apps/relay/package.json) for remote access, you host it on your own Linux server with no proprietary cloud limits or machine caps. [Install](./install.md)

## How is AgentVela maintained?

AgentVela is maintained independently by this repository, with its own roadmap and releases. When useful fixes or features land in upstream MIT-licensed sources, maintainers sync selected changes on a case-by-case basis.

## How do I use AgentVela remotely?

Your agents run wherever the AgentVela server runs: a desktop, home workstation, or VPS. You can connect from another computer, browser, or phone over your LAN, Tailscale, Desktop-managed SSH, or your own self-hosted [`agent-vela-relay`](../operations/02_connect-setup.md) instance. See [Remote access](./remote-access.md).

## How do I use AgentVela on my phone?

Build the React Native client from source using [apps/mobile/README.md](../../apps/mobile/README.md), then connect it to your server via a LAN/Tailscale pairing link or your self-hosted relay. The phone acts as a remote client; your host machine runs the agents and must stay online. [Mobile setup](./install.md#mobile-app) · [Remote access](./remote-access.md)

## Can I add a bunch of accounts for one provider?

You can add separate provider instances in **Settings → Providers** (for example, a personal and work profile)—see [Codex](./providers-codex.md#use-multiple-accounts) and [Claude](./providers-claude.md#multiple-accounts-and-presets). For larger credential pools, manage routing outside AgentVela through an external proxy such as [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in **Settings → Providers** with its own environment variables, API key, or custom base URL (see [OpenRouter](./providers-claude.md#openrouter-and-local-routers)). Existing subscription setups stay separate.

## Does my code go to third-party servers?

No. Your code, prompts, and repository data stay on your host machine and are sent only to the AI provider endpoints you configure. When using the self-hosted relay, traffic travels over your own `agent-vela-relay` server. AgentVela includes no built-in product analytics, telemetry, or crash reporting.

## Worktrees are eating my disk. How do I clean them up?

Open **Settings → Worktrees → Cleanup** and enable automatic worktree cleanup, or trigger a manual cleanup from the same panel. [Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

Yes. On iPhone and Android, dictation uses on-device speech by default, with the option to use a paired environment. On macOS 26 or later, desktop users can choose Apple Speech directly under **On this Mac** or choose an environment. Web and other desktop users can enable dictation by choosing an environment. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes, across desktop, web, and CLI. Note that there is no standalone `t3` CLI binary for Intel Macs—use the desktop app or run the server from source via Node. Windows users can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Almost always, the provider CLI is not installed or not on the `PATH` of the machine running the server. Sign in on the host machine first (such as `codex login` or `claude auth login`), and if AgentVela still cannot detect it—common with version managers—set **Binary path** explicitly in provider settings. [Provider setup](./install.md#providers)
