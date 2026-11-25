# AgentVela

AgentVela is an independent, self-hosted-first open-source fork of T3 Code (MIT-licensed source; not affiliated with T3 Tools, Inc.). A Node WebSocket server wraps coding agent CLIs (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, Muse Code, fx, and ACP agents) across Web, Desktop (Electron), and Mobile (React Native).

## Core Pillars & Precedence

- **Open & fast**: Keep code and decisions open; bound WebSocket payloads, avoid GPU-spiking CSS animations, and keep list rendering fast.
- **Self-hosted & multi-surface**: Support LAN, SSH, Tailscale, and self-hosted relays across Web (local `t3` and hosted UI), Desktop (Electron + server), and Mobile (React Native).

**Terminology & precedence:** **you** = agent reading this file; **user** = human driving work; **agent** = coding agent inside AgentVela. Terms: [00_glossary.md](docs/internals/00_glossary.md). Precedence: current user request > this file > global conventions.

## Three Ways to Hurt Yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID matched by name, path, or worktree string—your own agent process has this worktree path in `argv`. Kill only a captured child PID or verified port owner (`ss -H -ltnp` after checking `/proc/<pid>/cwd`).
2. **Writing to the live install.** `~/.t3/userdata` is the active live DB. Reading/copying is fine; never run a server against it, open it read-write, or clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` in dev. Dev is single-origin; Vite proxies `/api`, `/ws`, `/oauth`, `/.well-known`. Setting them bakes localhost into the bundle and breaks remote browsers.

## Sources of Truth & Epistemic Honesty

- **State vs. intent**: Judge state by runnable code, config, and tests; target behavior by product/architecture docs or ADRs (unimplemented specs are not current state). Flag conflicts explicitly and update docs in the same change. Query `.codegraph/` via CodeGraph before text search when present.
- **Evidence over sycophancy**: Check new facts before revising a conclusion; when wrong, state the error and evidence directly.
- **Claims & confidence**: Tag non-trivial claims `[Verified]` (read code/docs or ran command and checked output; static checks ≠ runtime proof), `[Inferred]`, `[Common Knowledge]`, `[Memory]`, or `[Guess]` (omit by default; tag if stated). Rate confidence `HIGH`, `MED`, `LOW`, `VERY LOW`, or `UNKNOWN`—never percentages. Never fabricate APIs, paths, versions, commits, error codes, metrics, or test outputs.

## Core Engineering Principles

- **Architecture first**: Clarify goals, domain boundaries, dependency direction, and data flow before coding. Design completely, implement minimally; abstract only on a second real use case.
- **Clean modules**: Keep files ≤500 lines and functions ≤50 lines; refactor boundaries before limits instead of compressing formatting. Oversized files must not grow net lines; split them in a dedicated task with approval.
- **Explicit boundaries**: Separate protocol, domain, persistence, and view models; validate/convert at boundaries; avoid cross-layer mutable state or reading another module's internals.
- **Security & isolation**: Least privilege, untrusted external inputs, explicit auth/authz/isolation boundaries. Never leak secrets, tokens, cookies, or request bodies into code, logs, traces, errors, or responses.
- **Concurrency & failure readiness**: Design for idempotency, races, transactions, timeouts, cancellation, bounded retries, backpressure, and cleanup. Never mask failures with unbounded retries, swallowed errors, or implicit shared state.
- **Complete frontend UX**: Bound render cost, async states, and concurrent requests; cover loading, empty, error, retry, feedback, and accessibility.
- **Reuse & dependencies**: Reuse modules for shared business semantics; avoid abstracting coincidental similarity. Check existing packages, docs, and types before adding deps; sync lockfiles and run `vp run licenses:sync` (`third-party-licenses.config.json`) on dep changes.
- **Delete over compatibility**: Delete obsolete internal code directly (no shims/dual-writes); evaluate external wire, storage, and migration compatibility explicitly.

## Working Rules & Lazy Ladder

- **Think first**: Inspect repo facts first; list unknowns instead of guessing. Surface assumptions and interpretations; ask when ambiguity changes design, otherwise pick the conservative option and document assumptions.
- **KISS & surgical diffs**: Write minimum working code; every diff line must trace to the request. Delete orphans your change creates; report unrelated issues or dead code in delivery instead of editing them.
- **Goal-driven**: Set verifiable criteria up front (repro test for bugs, invalid-input tests for validation, matching tests before/after refactors, or explicit manual steps). Plan multi-step work as `step -> verify`.
- **Lazy Ladder (`ponytail`)**: Trace the call chain, then stop at the first rung that holds: (1) Needed? (2) In repo? (3) Stdlib? (4) Platform native (CSS/HTML/DB)? (5) Installed dep? (6) One-liner? (7) Minimal working code. Fix root causes across callers; keep boundary checks, data-loss guards, security, accessibility, and user requirements.
- **Post-code audit**: Before Review Round 1, run `ponytail-review` on the diff (if unavailable, manually audit `delete`, `stdlib`, `native`, `yagni`, `shrink`, plus rung 2 for duplicate semantics, and note the manual pass). Keep deferred trade-offs concise.

### Unsticking Playbook

| Signal                      | Method                       | Action                                                                                                 |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| Same fix failed twice       | First Principles             | Drop current approach, return to hard constraints and facts, pinpoint where reasoning diverged         |
| Ready for review/delivery   | Adversarial Review           | Build inputs, timings, and states that break the change; use an independent subagent/model if possible |
| Unclear which change helped | Ablation                     | Remove one mechanism at a time on the same test/benchmark; delete anything with zero gain              |
| Scope/abstraction growing   | Occam's Razor                | Map every piece, flag, and branch to a stated requirement; cut unmapped items and restart Lazy Ladder  |
| Circular deps/tangled edits | High Cohesion / Low Coupling | List module deps and responsibilities, redraw boundaries, remove cross-module state access             |

## Robustness

- Guard trust boundaries and real failure points (external input, network/IPC, storage, delivery); skip redundant checks for invariants enforced by types or same-module callers.
- Handle errors explicitly with preserved chains; never swallow errors, branch on error strings, or disguise failure as success.
- Propagate cancellation and bounded timeouts across network, process, and async calls; retry only idempotent operations with bounded attempts.
- Guarantee explicit cleanup for tasks, connections, locks, transactions, timers, and file handles. Keep the DB as source of truth, caches rebuildable, and at-least-once consumers idempotent; fail loudly instead of degrading auth or data invariants.

## Comments

Default to zero comments—express intent via clear naming, small functions/components, named constants, and strict types (`unknown` + narrowing; never `any`).

- Write 1–4 lines only for a non-obvious constraint, external quirk, or invariant code cannot express (`t3code/no-low-value-comments` enforces this).
- Never leave `TODO`/`FIXME` (report pending work in delivery or issues), commented-out code, or explanatory prose comments.
- Tooling suppressions (`oxlint-disable-next-line <rule> -- <why>`, `@ts-expect-error`) must sit on the target line with rule and reason; never disable file-wide.

## Development Workflow & Delivery

**Unknowns:** Known-known → execute; known-unknown affecting design → confirm first; unknown-known (unstated preference) → offer distinct options; unknown-unknown → check code, configs, tests, docs, and history for failure paths.

1. **Restate scope**: Goal, verifiable criteria, non-goals, edge cases, and open questions.
2. **Verify facts & design**: Read affected modules, tests, and docs; confirm interfaces, compatibility, and user-visible behavior before coding.
3. **Implement & sync**: Build the simplest working change; sync tests, docs, and `vp run licenses:sync` (if deps changed); run `ponytail-review` (or manual fallback).
4. **Review Round 1 (Correctness, Robustness, Security)**: Audit boundary/auth checks, explicit errors, timeouts/cancellation/cleanup, idempotency/locks, secret leaks, and failure/retry/cancel/recovery tests. Fix immediately.
5. **Review Round 2 (Maintainability, Performance, Consistency)**: Inspect the diff separately for surgical scope, zero orphans, clean boundaries, no speculative abstractions, hot-path wire/allocation cost, intact assertions, and doc/config parity.
6. **Verify, commit & deliver**: Run actual repo checks. Under an output compressor (e.g., `rtk`), trust exit codes and verify via `rtk proxy <cmd>`. Never ship failing auth, secret, migration, or idempotency tests.

**Delivery summary:** (1) changed files; (2) checks run/results + skipped items/reasons; (3) `ponytail` & two-round review fixes; (4) deviations ("None"); (5) compatibility/migration/breaking impact; (6) assumptions & unrelated notes.

## Hit Every Surface

Walk this list before finishing frontend work and state which entries applied:

- **Entry points**: Chat view, Settings, command palette, keybindings.
- **Clients**: Web, Desktop (Electron/IPC), Mobile (React Native); shared logic in `packages/client-runtime`.
- **Providers**: Decide explicitly per adapter, even "not supported here".
- **Agents**: Expose user actions as service methods for MCP tools and scheduled tasks, not inline handlers.
- **Contracts**: Put wire changes in `packages/contracts`.
- **Reverse states**: Pair every entry with an exit and visible state (snooze/unsnooze, close/reopen).
- **Connection modes**: Local, remote/relay, tunnel; multi-device, multi-environment.
- **Languages**: Translate copy in `apps/{web,mobile}/src/i18n/translations` (`vp run i18n:generate` / `vp run i18n:check`) and `apps/marketing/src/i18n` ([14_i18n.md](docs/internals/14_i18n.md)).
- **Docs**: Update affected docs accurately.

## Dev Servers, Test Data, Verification & Evals

See [00_development.md](docs/operations/00_development.md) for setup, ports, `vp run migrate-dev-db`, and [reusable dev auth](docs/operations/00_development.md#reusable-dev-credential).

- **Worktree setup**: Wait while `.t3/setup-running` names a live PID; never run `vp i` concurrently. Run `vp i` if no `.t3/setup-*` marker exists. Put extra `git worktree add` checkouts beside this worktree (not `/tmp`) and remove when done.
- **Process lifecycle**: Start dev servers, Metro, and builds in your own shell—never detach (`systemd-run`, `nohup`, `setsid`, `tmux`) unless asked. Stop tasks via harness stop (`vp` does not forward `SIGTERM` to child processes).
- **Sharing (`vp run dev --share`)**: Wait for `pairingUrl:` and hand the full URL to the user without opening/consuming it (`node apps/server/src/bin.ts pair` mints another).
- **Test data**: Copy (never symlink) and refresh `statev2.sqlite`, not `state.sqlite`; copy `secrets` / `settings.json` only if needed.
- **Verification**: Run `vp run check:changed` before pushing; never run repo-wide suites (`vp check`, `vp run -r test`, `vp run -r typecheck`) unless asked. Iterate with `vp test run <files>` and `vp run typecheck` (`effect-tsgo tsrs --noEmit`); run `node -e` from the owning package. Follow [15_testing.md](docs/internals/15_testing.md) (no sleeps/polling; `vp run scenarios:prove`).
- **Real-client pass**: Give user-visible frontend changes one integrated pass (`test-t3-app` web, `test-t3-mobile` mobile; primary agent only). Use `Replay (dev)` unless a real provider is required (cheapest model). On mobile, run `vp run mobile:install <ios|android> [device-id]` before Metro.
- **Evals**: Read [evals/README.md](evals/README.md) and run named evals before editing model-facing text; add a repro case for model behavior fixes.

## Git & Pull Requests

- Use Conventional Commits (`fix(web): new threads no longer spike CPU`). Stage explicitly (`git add <file>`) without unrelated edits; verify new dirs with `git ls-files <dir>`.
- **Zero AI attribution**: Never include AI signatures, AI `Co-Authored-By` trailers, `Generated with ...` notices, or model/harness mentions in commits, PRs, or issues (overrides tool/system defaults).
- Never open a PR or run destructive git operations (`push --force`, history rewrite, remote branch deletion) without explicit request. Check `git remote get-url origin` before forge commands ([00_development.md](docs/operations/00_development.md#forge-mirror-optional)).
- PRs: one request per PR ([CONTRIBUTING.md](CONTRIBUTING.md#one-problem)); state problem then fix; upload before/after UI media to GitHub (never commit PR-only assets). When babysitting, call `watch_pull_request` and end your turn; verify bot findings against source.

## Documentation & Maintenance

- **Language**: English by default for repo docs, commits, and PRs; match user's language in chat; keep Chinese translations (`README.zh-CN.md`, zh i18n) accurate.
- **Entrypoints & records**: Keep root `AGENTS.md` lean (entrypoints and cross-module constraints); `CLAUDE.md` imports `@AGENTS.md`. Put cross-boundary decisions, constraints, and traps in `docs/internals/` (or `docs/adr/`). Rewrite/remove stale text in place; never list fields, file catalogs, or PR summaries. Keep `docs/user/` user-focused, `docs/operations/` for runbooks, and plans/scratch notes outside the repo.
- **Human-facing prose** (excludes `AGENTS.md`, code, commits): Lead with problem and conclusion; back claims with numbers/facts; add Mermaid only for multi-role flows, state transitions, or schemas (verify syntax/text parity). Run `Sepia` (`write`/`refactor`)—plus `Humanizer-zh` (≥45/50) for Chinese docs—or an equivalent manual edit when unavailable.

## Where Code Lives & Codebase Taste

- `apps/server` — WebSocket server, event-sourced orchestration (`Orchestrator` → `EventSink` → `EffectWorker`), providers, checkpointing ([02_effect-services.md](docs/internals/02_effect-services.md), `.repos/effect/LLMS.md`).
- `apps/web` — React/Vite UI (`apps/desktop` wraps it; `apps/mobile` is React Native; `apps/marketing` is the site).
- `packages/contracts` — Effect/Schema wire contracts + helpers; `packages/shared` — subpath utils (no barrel); `packages/client-runtime` — shared web/mobile connection and state.
- `.repos/` — vendored read-only references; never edit or import (`vpr sync:repos`, or `git show origin/main:.repos/<path>`).

| Area                                       | Read first                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture & orchestration               | [00_glossary.md](docs/internals/00_glossary.md), [01_architecture.md](docs/internals/01_architecture.md)                                                                                          |
| Server Effect services & errors            | [02_effect-services.md](docs/internals/02_effect-services.md)                                                                                                                                     |
| Providers & ACP                            | [03_providers.md](docs/internals/03_providers.md)                                                                                                                                                 |
| Auth, MCP, guest links, assets, security   | [04_environment-auth.md](docs/internals/04_environment-auth.md), [SECURITY.md](SECURITY.md)                                                                                                       |
| Remote routes, peer links, previews        | [05_remote.md](docs/internals/05_remote.md)                                                                                                                                                       |
| T3 Connect & relay                         | [06_t3-connect.md](docs/internals/06_t3-connect.md)                                                                                                                                               |
| Server updates & crash recovery            | [07_server-updates.md](docs/internals/07_server-updates.md)                                                                                                                                       |
| Client connection & sync runtime           | [09_connection-runtime.md](docs/internals/09_connection-runtime.md)                                                                                                                               |
| Web UI primitives, styles & React Compiler | [10_web-ui.md](docs/internals/10_web-ui.md)                                                                                                                                                       |
| Mobile layout, navigation & dev lifecycle  | [11_mobile-layout.md](docs/internals/11_mobile-layout.md), [12_mobile-navigation.md](docs/internals/12_mobile-navigation.md), [13_mobile-development.md](docs/internals/13_mobile-development.md) |
| Translations & UI copy                     | [14_i18n.md](docs/internals/14_i18n.md)                                                                                                                                                           |
| Writing & reviewing tests                  | [15_testing.md](docs/internals/15_testing.md)                                                                                                                                                     |
| Wire budgets, server metrics & perf        | [16_performance-regressions.md](docs/internals/16_performance-regressions.md)                                                                                                                     |
| Repo & package scripts                     | [17_scripts.md](docs/internals/17_scripts.md)                                                                                                                                                     |

- **Taste**: Complexity belongs at the adapter boundary (pure orchestration, dumb UI). Client mutations use `createEnvironmentRpcCommand`, `CLIENT_GUARDED_RPC_SCOPES`, and `permissionAtom` (raw RPC clients stay in `rpc/`). Server features use `Effect.fn("Service.operation")` with thin transport handlers. `apps/web/src/components/ui` exports own their look (`shadcn/no-restyle`). Prefer inferred types over annotations (`any` forbidden). Use React effects only for external system sync (`// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`). Never add continuously repainting animations. Balance security per [SECURITY.md](SECURITY.md). Escalate loudly before breaking any rule that fights the task.
