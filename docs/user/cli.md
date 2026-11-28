# CLI reference (`agentvela`)

The `agentvela` command runs and manages AgentVela servers, background services, remote access, threads, workflows, and diagnostics. Run `agentvela --help` or `agentvela <command> --help` for full flags.

See [Install](./install.md#command-line) for building `agentvela` from source and putting it on your `PATH`.

## Running and connecting

| Command                                | Description                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `agentvela [path]` / `agentvela start` | Start a foreground server and open the web app (optionally in a project directory).                                                   |
| `agentvela serve`                      | Start the server without opening a browser (`--lan`, `--tailscale-serve`, `--host`, `--port`, `--base-dir`).                          |
| `agentvela app [path]`                 | Open a directory as a project/thread in the running desktop app.                                                                      |
| `agentvela up`                         | Interactive setup for remote access (self-hosted relay and/or LAN) plus background service (`--relay`, `--lan`, `--no-lan`, `--yes`). |
| `agentvela relay`                      | Manage the self-hosted relay link (`login`, `logout`, `link`, `unlink`, `status`).                                                    |
| `agentvela status`                     | Show how other devices can reach this host (`--json`).                                                                                |
| `agentvela pair`                       | Generate a one-time pairing URL / QR code (`--tailscale`, `--scope <scope>`).                                                         |

## Background service and updates

| Command                                     | Description                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentvela service`                         | Manage the background service (`install`, `status`, `restart`, `uninstall`, `protect [--undo]`). See [Background service](./background-service.md). |
| `agentvela update [version]`                | Update `agentvela` and the service (`--channel nightly`, `--allow-downgrade`, `--yes`).                                                             |
| `agentvela install` / `agentvela uninstall` | Install or remove the `agentvela` launcher and background service (keeps `~/.agentvela/userdata`).                                                  |

## Threads, projects, and workflows

| Command              | Description                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentvela thread`   | Script threads on the host (`start`, `send`, `show`, `list`; supports `--wait`, `--json`, `--worktree`, `--provider`, `--model`, `--option`). See [Host scripts](./outside-agents.md#host-scripts-agentvela-thread). |
| `agentvela project`  | Manage projects on the host (e.g. `agentvela project add <path> --track <folder>`).                                                                                                                                  |
| `agentvela workflow` | Start and steer durable workflows (`start`, `list`, `show`, `resume`, `cancel`, `questions`, `signal`, `withdraw`, `hooks`, `store`). See [Workflows](./workflows.md).                                               |

## Environments, auth, themes, and policy

| Command                 | Description                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentvela environment` | Link or manage peer environments (`agentvela environment link <addr> --pairing-code <code> --access <mode>`, `--from <file>`).                    |
| `agentvela auth`        | Manage pairing codes, sessions, and relay device approvals (`pairing create`, `session list/revoke/issue`, `connect-device list/approve/revoke`). |
| `agentvela theme`       | Manage server-published themes (`set <id>`, `clear`, `show`). See [Appearance](./appearance.md#environment-themes).                               |
| `agentvela policy`      | Validate, inspect, and generate MDM/GPO templates for [managed policies](./managed-policy.md) (`check`, `show`, `settings`, `templates`).         |

## Diagnostics and maintenance

| Command                   | Description                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `agentvela doctor`        | Inspect database size and reclaim disk space (`--dry-run`, `--fix`).                                     |
| `agentvela browser setup` | One-time Linux host setup (AppArmor sandbox profile, libraries, fonts) for the headless preview browser. |
| `agentvela trace summary` | Summarize local server trace latency and errors (`--since 30m`, `--limit 50`).                           |
| `agentvela triage`        | Launch Claude Code, Codex, or Antigravity in your terminal with the AgentVela triage playbook.           |
