# Upstream Sync Runbook

AgentVela tracks its own `origin` (`redwolf2019/AgentVela`) while occasionally merging vetted improvements from `pingdotgg/t3code`. Always preserve Git's two-parent merge history so future syncs keep an accurate merge-base.

## One-time remote setup

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git
```

## Standard incremental merge

1. Fetch and inspect incoming commits against `HEAD`, then pin a specific audited commit SHA:

```sh
git fetch upstream main
git log --oneline HEAD..upstream/main
```

2. Start an uncommitted merge to the pinned SHA so exclusions and checks complete in a single atomic merge commit:

```sh
git merge --no-commit --no-ff <audited-sha>
```

## Always-exclude checklist

Several excluded upstream changes may auto-merge without Git conflict markers. Audit `git diff --name-status HEAD` and `git log --oneline <merge-base>..<audited-sha>` explicitly before committing:

- **Clerk authentication**: Remove `@clerk/*` from `package.json`, `pnpm-workspace.yaml` (including `catalog`, `overrides`, `patchedDependencies`, and `minimumReleaseAgeExclude`), and any `patches/@clerk*` files.
- **Built-in telemetry and feedback**: Keep `AnalyticsService`, `relayTracing`, `FeedbackReport.ts`, `expo-observe`, and upstream telemetry docs deleted; revert upstream `DO_NOT_TRACK` / `isCiEnvironment` / `isRelayTracingEnabled` additions while keeping user-configured OTLP export in `packages/shared/src/otelEnvironment.ts`.
- **Legacy T3 Connect relay**: Keep `infra/relay/` removed and reject `T3 Connect` / `cloudflared` regressions across server, desktop IPC, contracts, and user docs; AgentVela uses `apps/relay/`.
- **Upstream release bumps**: Keep AgentVela's own versions in `apps/{desktop,server,web}/package.json` and `packages/contracts/package.json`.
- **Branding and governance docs**: Preserve AgentVela's `README.md`, `README.zh-CN.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, and de-T3'd sections of `docs/user/*`.
- **Self-hosted network defaults**: Preserve fail-closed privacy and mirror controls documented in [07_self-hosted-network-hardening.md](07_self-hosted-network-hardening.md) (no `app.t3.codes` fallbacks, no Google Favicon proxy, `enableProviderUpdateChecks: false` default, Expo OTA disabled by default, `ManagedPolicy` telemetry/SSH enforcement, custom vendor endpoint guards, and MCP connector disclosures).

## Post-merge verification

1. **Dependencies and licenses**: Reset `pnpm-lock.yaml` from `HEAD` (`git checkout HEAD -- pnpm-lock.yaml`), regenerate with `vp i`, and run `vp run licenses:sync`.
2. **Translations**: Merge `apps/{web,mobile}/src/i18n/translations/*.json` at the JSON key level so deleted telemetry/T3 Connect keys are not resurrected, format with `vp fmt`, and verify with `vp run i18n:check`.
3. **MCP context budget**: Run `vp test run apps/server/src/provider/AgentContextBudget.test.ts` and update `apps/server/src/provider/agentContextBudget.json` only for expected intentional tool schema deltas.
4. **Migrations and hygiene**: Confirm zero unmerged paths, zero `@clerk/` references, and run `Migrations.test.ts` whenever new SQLite migrations arrive.
5. **Changed checks**: Ensure the Node version pinned in root `package.json` (`engines.node`) is active on `PATH` ahead of older Node binaries, then run:

```sh
vp run check:changed origin/main
```

Pass `origin/main` explicitly because adding `upstream` introduces a second remote `main` ref. Do not push automatically; review the merge commit locally first.
