# Remote access

Drive AgentVela from your phone, browser, or another desktop app while your agents run on a host computer or server. The host must stay awake and running while you work.

## Self-hosted relay (recommended)

A self-hosted [`agent-vela-relay`](../operations/02_connect-setup.md) links your host to your other devices without router port forwarding or third-party cloud accounts.

- **Desktop host**: Open **Settings → Sharing & access**, enter your Relay URL (such as `https://relay.example.com`), sign in, and enable relay linking for that environment (note: closing the desktop app's last window stops its local server—use the [background service](./background-service.md) for unattended access).
- **CLI / headless host**: Run `t3 up` and choose the relay (or `t3 up --relay` non-interactively; `t3 relay link --url <relay-url> --token <enroll-token>` links headlessly with a one-time enrollment token minted in Web or Desktop Settings). Check status with `t3 relay status` or `t3 status [--json]`.
- **Other devices**: Configure the same Relay URL, sign in to the same relay user account, and pick the environment. In a hosted web UI served by `agent-vela-relay`, signing in lists compatible machines linked to your account automatically.

### Approve new devices

By default, any device signed into your relay user account can connect. Turn on **Require approval for new devices** in **Settings → Sharing & access** on the host so new devices must present a short code (valid 10 minutes) that you approve from an existing device or via `t3 auth connect-device approve <code>`. Revoke devices in **Settings → Sharing & access** or with `t3 auth connect-device revoke <code>`.

## Pair over a LAN or private network

- **Desktop host**: Enable **Settings → Sharing & access → Network access** (restarts desktop) and create a one-time pairing link.
- **CLI host**: Run `t3 up --lan` (background service) or `t3 serve --lan` (foreground), then run `t3 pair` to generate a QR code / pairing URL (`t3code://pair` opens directly in the desktop app).
- **Hosted web UI**: When `serve_web_ui = true` on `agent-vela-relay`, your relay URL serves the web client over HTTPS. Any hosted web client requires an HTTPS endpoint (self-hosted relay or Tailscale HTTPS). For plain HTTP on a LAN, open the direct pairing URL in a local browser or pair from the desktop/mobile app. For custom CAs on Android, install the CA certificate in Android security settings.
- **Session lifetime**: Paired devices stay signed in while active; sessions unused for 30 days must re-pair.

### Reach one machine several ways

A host can have multiple routes (LAN, Tailscale, VPN, public URL, SSH, self-hosted relay). AgentVela automatically learns LAN and Tailscale routes when network access is enabled, connects over the fastest working route, and switches back to higher-priority routes when you return home. Reorder or add routes in **Settings → Environments** (**Add route**).

### Tailscale HTTPS

Join both devices to a tailnet with [MagicDNS and HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates) enabled (on Linux, grant [operator permission](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission)).

- **Desktop**: Enable **Settings → Sharing & access → Tailscale HTTPS**.
- **CLI**: Run `t3 serve --tailscale-serve` or `t3 pair --tailscale` (use `--tailscale-serve-port` if 443 is taken; remove with `tailscale serve --https=443 --set-path=/ off`).

### Balance new threads across machines

On web and desktop with 2+ connected machines, enable **Settings → Environments → Load balancing** (per client) to auto-select a host for new threads in shared projects. Set each machine to **Prefer**, **Normal**, **Less often**, or **Manual only**.

## Desktop-managed SSH

In the desktop app, open **Settings → Environments → Add environment → SSH** and enter a host or SSH alias (e.g. `user@example.com`). AgentVela downloads its runtime to `~/.t3/runtime` on the Linux or Apple Silicon macOS host, starts or reuses a server, and manages port forwarding automatically.

- Provider CLIs must be on a non-interactive login shell's `PATH` (check with `ssh user@example.com 'sh -lc "command -v claude codex"'`).
- For 2FA/Duo hosts on macOS/Linux, enable SSH `ControlMaster` in `~/.ssh/config` and open a terminal SSH session first.
- Revoke unused SSH sessions in **Settings → Sharing & access** or `t3 auth session revoke <id>`.

## Browser on a remote environment

Browser tabs belong to the host environment so you and your agents share them from any device.

- **Streaming & local loading**: Web and mobile stream tabs from the host. In the desktop app, tabs you open for a remote environment load locally while routing `localhost` requests to the host over the **preview tunnel** (so element picker and annotations work locally).
- **Port forwarding (desktop)**: Forward any remote host port to your local `localhost` via the thread's **Servers** list or **Forwarded ports** in the command palette (`Cmd/Ctrl-click` forwards and opens in your browser).
- **Open on this device (mobile)**: Tap **Open on this device** on a streamed `localhost` tab or long-press a `localhost` link in chat for native touch scrolling.
- **Disable preview tunnel**: Turn off **Settings → Sharing & access → Preview tunnel** on the host (or via [managed policy](./managed-policy.md#other-capabilities)) to disable port forwarding and **Open on this device** (streamed tabs continue working).
- **Take control**: Click **Take control** before typing into an agent's tab, and release control when done.
- **Local servers**: AgentVela lists listening ports from your terminals and agents as `http://localhost:<port>` (set a script's **Preview URL** for HTTPS or subpaths). Disable discovery with `T3CODE_PORT_DISCOVERY=0`.

### Browser host setup

The first server browser tab downloads ~120 MB headless Chromium (shared with [HTML renders](./html-renders.md)). On Ubuntu 23.10+ or minimal Linux containers, run the one-time setup command on the host:

```sh
sudo t3 browser setup
```

This installs an AppArmor profile for Chrome's sandbox plus missing libraries and fonts. Never run the AgentVela server as root (Chrome's sandbox rejects root); if sandboxing is impossible on your host, set `T3CODE_SERVER_BROWSER_SANDBOX=0` in the server environment and restart.

## Link another environment

Link two AgentVela machines (beta) so agents on one can launch, message, delegate to, and manage threads on the other.

1. Enable **Settings → Labs → Linked environments** on **both** machines (or `"linkedEnvironmentsEnabled": true` in `userdata/settings.json`).
2. On the source machine, open **Settings → Environments → Linked environments → Link** (or drag from one machine's `+` to another on the Environments map, or run `t3 environment link <address> --pairing-code <code> --access <mode>`). Use **Link several…** or `--from <file>` for batch linking.
3. Links are one-way (tick **Also link … back** for two-way) and do not chain. Links expire after 30 days of inactivity and can be revoked in **Settings → Sharing & access** or **Forget**.

- **Access boundary**: Agents never get more permissions on the target than the link's access level or their own thread mode. Below Full access, linked agents can only modify threads they started and skip project setup scripts.
- **Delegation**: Agents can target a linked machine with `delegate_task`, or ask you to link an unlinked machine via an in-thread approval card.

### Read a linked machine's threads

Open a delegated task or thread link on a linked machine to follow it live (read-only) in the right panel without pairing your client directly. Click **Connect to interact** to pair and take action (one-click if the link has Full access and you can manage access). Files, images, and HTML renders stay on the remote machine until you connect directly.

## Manage or revoke access

Manage pairing links and active client sessions in **Settings → Sharing & access** or via `t3 auth --help`.

- **Scoped tokens**: Pass `--scope <scope>` (repeatable) to `t3 pair`, `t3 auth pairing create`, or `t3 auth session issue` to restrict permissions (e.g. `orchestration:read`, `source-control:write`, `filesystem:read`, `filesystem:write`, `terminal:operate`, `relay:configure`). Re-pair with a fresh link to change an existing client's scopes.
- **Remove a host from your relay**: Disable relay linking in **Settings → Sharing & access** on the host, or run `t3 relay unlink` (and `t3 relay logout` to clear the saved relay login).
- Treat pairing URLs and codes as passwords—never paste them into logs or screenshots.

## Desktop app as a remote only

Switch off **Settings → Environments → Local environment** in the desktop app to run with no local server, WSL backend, or incoming connections while continuing to drive remote hosts (if a local background service uses the same home state directory (`~/.t3`), **Open in** still works locally).

## Troubleshooting

See [Self-hosted relay troubleshooting](./t3-connect-troubleshooting.md) for step-by-step connection diagnostics, and [Outside agents](./outside-agents.md) for MCP connections.
