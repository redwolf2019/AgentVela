# Running AgentVela in the background

Run AgentVela as a background user service on Linux, macOS, or Windows so your host stays reachable without keeping a terminal open.

## Manage the service

Install the `agentvela` CLI first ([Command line](./install.md#command-line)), then run these commands on the host machine:

| Task                                    | Command                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------- |
| Set up access from other devices        | `agentvela up`                                                          |
| Check how other devices reach it        | `agentvela status`                                                      |
| Install and start (or repair)           | `agentvela service install`                                             |
| Check status and log path               | `agentvela service status`                                              |
| Restart                                 | `agentvela service restart`                                             |
| Stop and remove from startup            | `agentvela service uninstall`                                           |
| Remove service, launcher, and downloads | `agentvela uninstall` (keeps `~/.agentvela/userdata` and `service.env`) |

- Pairing codes are never written to logs; run `agentvela pair` or `agentvela up` on the host to connect a device.

## Local network access

New services bind to localhost only. Run `agentvela up --lan` (sets `T3CODE_LAN=true` in `service.env`) to listen on LAN and Tailscale addresses for direct desktop/mobile connections, or `agentvela up --no-lan` to disable it. Anyone on that network can reach the port (gated by pairing). `T3CODE_HOST` overrides `T3CODE_LAN`. Other devices can also reach it through your self-hosted relay.

## Configure the service environment

Add `KEY=VALUE` entries to `service.env` in your AgentVela home directory (`~/.agentvela/service.env` by default). Values are literal (quote spaces or `#`; no shell expansion) and survive installs and updates.

```dotenv
T3CODE_PORT=3773
T3CODE_HOST=127.0.0.1
```

- `PATH`, `T3CODE_HOME`, `T3_BOOT_SERVICE_UNIT`, and `T3_SERVICE_LAUNCHER_CONTEXT` cannot be overridden here.
- Run `agentvela service restart` after editing (and `chmod 600 ~/.agentvela/service.env` if it holds secrets).

## Platform support

- **Linux**: Requires systemd user services with lingering enabled so AgentVela starts at boot and survives logout.
- **macOS**: Starts at login, stops at logout. Keep the Mac logged in and awake for unattended access. If agents can't read Desktop/Documents/Downloads, grant Full Disk Access to the `agentvela` path in `~/Library/LaunchAgents/io.github.redwolf2019.agentvela.service.plist`.
- **Windows**: Runs windowless via Task Scheduler (`agentvela-<domain>-<user>`) while signed in and auto-restarts on exit. Lock the screen instead of signing out for unattended access.

> Note: `agentvela up --relay` installs the service when you set up relay linking, but the two are managed separately. Unlinking from the relay (`agentvela relay unlink`) does not stop or uninstall the service.

## Keep the server responsive under memory pressure (Linux)

On Linux, agents run at lower priority than the server, but heavy memory use can still trigger the OOM killer. Run as your normal user:

```sh
agentvela service protect
```

It previews system changes, asks for confirmation and `sudo`, and optionally protects Tailscale and SSH too. Run `agentvela service restart` for OOM-killer protection to take effect, or `agentvela service protect --undo` to remove it.

## Troubleshooting

Run `agentvela service status` on the host to see the log path and health checks:

| Status                                 | Fix                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linger-disabled`                      | Run `sudo loginctl enable-linger "$(id -un)"` (or `ssh -t your-server '...'`), then retry setup as your normal user. Never run AgentVela as root. |
| `linger-unavailable`                   | Check `loginctl show-user "$(id -un)" --property=Linger` and verify `systemd-logind`.                                                             |
| `user-manager-unavailable`             | Run `systemctl --user status` in a login session to verify systemd user support.                                                                  |
| `service-disabled` / `service-stopped` | Check the log and `systemctl --user status agentvela.service`, then run `agentvela service install`.                                              |
| `restart-pending`                      | Run `agentvela service restart` to switch to the newly installed version.                                                                         |

For relay failures after linking, see [self-hosted relay troubleshooting](./t3-connect-troubleshooting.md).

## Reclaim database space

AgentVela automatically prunes old internal history while keeping conversations. Older databases that still hold freed space show a **Reclaim** button in **Settings → Maintenance** when at least 1 GiB is reclaimable (pauses the server/agents during repair).

For manually started servers (or CLI use), stop any hand-started server or desktop app and run:

```sh
agentvela doctor          # Interactive repair (auto-stops/restarts a background service)
agentvela doctor --dry-run
agentvela doctor --fix    # Non-interactive recommended repairs
```

- Needs free disk space of ~2× active data size (in `TMPDIR`/`/var/tmp` and beside the database). Large databases can take over an hour.
- `agentvela doctor` optionally offers to remove the legacy pre-0.1.0 `state.sqlite` backup only when all active projects and threads exist in the current database (`--fix` never deletes it automatically).
