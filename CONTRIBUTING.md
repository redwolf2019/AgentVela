# Contributing to AgentVela

AgentVela is an independently maintained, self-hosted-first open-source project in early development. Maintainers run AgentVela's roadmap and releases independently, occasionally syncing selected upstream improvements when useful.

Bug fixes, documentation and translation updates, and focused features aligned with AgentVela's goals are welcome. Review capacity is small, so narrow, well-verified pull requests move fastest.

## Ways to help

- **Issues and triage.** Search [GitHub Issues](https://github.com/redwolf2019/AgentVela/issues) before filing a report. Include reproduction steps, the affected surface (Desktop, Web, Mobile, CLI, or `apps/relay`), your OS and environment, and redacted logs. Confirming an open bug on your setup or noting when an old issue no longer reproduces helps directly.
- **Bug fixes and small improvements.** Clear bug fixes, doc corrections, and UI translation updates can go straight to a pull request without filing an issue first.
- **Features and larger changes.** Open an issue on [GitHub Issues](https://github.com/redwolf2019/AgentVela/issues) before writing code if you plan to add a broad feature, introduce a new agent or source-control provider, change core architecture, overhaul the UI, or alter wire protocols or storage schemas.
- **Docs and translations.** Some files under `docs/` still come from upstream and are being updated progressively for AgentVela. UI translation catalogs live under `apps/{web,mobile,desktop}/src/i18n/translations`; see [Translating the UI](docs/internals/14_i18n.md) before modifying copy.

## Scope and priorities

Changes that fit best:

- Self-hosted connectivity over LAN, SSH, Tailscale, and `apps/relay`
- Cross-surface consistency across Desktop, Web, Mobile, and `packages/client-runtime`
- Runtime performance: bounded WebSocket payloads, fast list rendering, and avoiding continuously repainting CSS animations
- Multi-agent orchestration, ACP/MCP interoperability, and local packaging/distribution

Out of scope: proprietary cloud lock-in, built-in telemetry or crash reporting (intentionally removed from AgentVela), and uncoordinated large rewrites.

## Development setup

Install [Vite+](https://viteplus.dev/guide/) (`vp` manages the pinned Node.js toolchain from `package.json`), then install dependencies and start the dev server:

```sh
vp i
vp run dev
```

Open the pairing URL printed in the terminal to authenticate your browser session. Use `vp run dev:desktop` for Electron or `vp run dev --share` to expose the dev server over Tailscale. Dev mode registers the local `Replay (dev)` ACP agent so you can test threads without paid model keys.

For full platform build prerequisites, see [the development runbook](docs/operations/00_development.md#first-checkout) and [apps/mobile/README.md](apps/mobile/README.md). Keep two dev rules in mind: never run a dev server against a live `~/.t3/userdata` directory, and never set `VITE_HTTP_URL` or `VITE_WS_URL` in dev (Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known` single-origin).

Where code lives:

- `apps/server` — Node WebSocket server, Effect orchestration, providers, and checkpointing
- `apps/web`, `apps/desktop`, `apps/mobile` — React/Vite web UI, Electron wrapper, and React Native client
- `apps/relay` — Self-hosted `agent-vela-relay`
- `packages/contracts`, `packages/client-runtime`, `packages/shared`, `packages/provider-*`, `packages/source-control-*` — Wire schemas, shared client runtime, utilities, and adapters
- `.repos/` — Vendored read-only references (never edit or import)

## Pull request guidelines

<a id="one-problem"></a>

### One problem per PR

Solve one bug, feature, or improvement per PR, including every change it needs across contracts, server, clients, tests, and docs. Keep unrelated refactors and cleanups in separate PRs.

### Commit and PR titles

Use Conventional Commits in plain language, such as `fix(web): new threads no longer spike CPU` or `feat(relay): add session timeout config`.

<a id="verification"></a>

### Checks and verification

Run `vp run check:changed` before pushing. It formats and lints changed files, runs `knip`, verifies generated GraphQL operations, typechecks affected packages with `@effect/tsgo`, checks React Compiler coverage, and runs nearby tests.

For focused iteration, run `vp test run <files>`, `vp lint <files>`, `vp run --filter <pkg> typecheck`, `vp run i18n:check` (for translation edits), and `vp run licenses:sync` (when dependencies change). Avoid running repo-wide test or typecheck suites unless asked.

In the PR description, state what you ran and what you observed ("tests pass" alone is not enough). For UI changes, attach before and after screenshots—or a short recording for motion or interaction changes—directly on GitHub, and never commit PR-only assets (CI rejects tracked files under `.github/pr-assets`).

Check [AGENTS.md](AGENTS.md) and [docs/README.md](docs/README.md) for codebase conventions, [docs/internals/15_testing.md](docs/internals/15_testing.md) for testing rules, and [evals/README.md](evals/README.md) if you change model-facing prompts or agent context budgets.

<a id="ai-assisted-contributions"></a>

### AI-assisted contributions

Any AI tool or model is welcome; AgentVela has no model allowlist or blocklist. You remain responsible for every line you submit: understand the design, read the full diff, and verify the behavior yourself. Low-effort or unreviewed automated spam PRs will be closed.

Follow the repository's zero-AI-attribution rule from [AGENTS.md](AGENTS.md): omit AI signatures, AI `Co-Authored-By` trailers, `Generated with ...` footers, and model or tool notices from commits, PR descriptions, and issues.

## Security vulnerabilities

Do not report security vulnerabilities in public issues or pull requests. Submit them privately via [GitHub Security Advisories](https://github.com/redwolf2019/AgentVela/security/advisories/new). See [SECURITY.md](SECURITY.md) for AgentVela's trust boundaries and threat model.

## License

Source code in this repository is licensed under the [MIT License](LICENSE), and contributions are accepted under the same terms.
