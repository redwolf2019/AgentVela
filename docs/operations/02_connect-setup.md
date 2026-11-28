# Self-Hosted Relay Setup (`agent-vela-relay`)

Run [`agent-vela-relay`](../../apps/relay/package.json) on any public Linux host behind a single HTTPS domain, then enroll your AgentVela machines and connect clients at runtime. There are no third-party auth providers, external databases, `cloudflared` binaries, or wildcard DNS records to provision. See [Self-Hosted Relay Architecture](../internals/06_t3-connect.md) for protocol and trust-boundary details.

## Configuration (`relay.toml` and Environment Overrides)

`agent-vela-relay` reads [`relay.toml.example`](../../apps/relay/relay.toml.example) via `--config <path>` and applies `AGENT_VELA_RELAY_*` environment variable overrides on top:

```toml
[server]
bind = "127.0.0.1:8787"
public_url = "https://relay.example.com"
data_dir = "/var/lib/agent-vela-relay"
serve_web_ui = true
# web_ui_dir = "/opt/agent-vela-relay/web-dist"
trust_proxy = true

[auth]
allow_public_registration = false
access_token_ttl_seconds = 900
refresh_token_ttl_days = 30
enrollment_token_ttl_minutes = 15
device_code_ttl_minutes = 10

[tunnel]
max_frame_bytes = 262144
heartbeat_interval_seconds = 20
heartbeat_timeout_seconds = 60
compression = true
initial_stream_window_bytes = 524288
proxy_timeout_ms = 30000

[rate_limit]
login_max_attempts = 10
login_window_seconds = 60
dpop_max_attempts = 60
proxy_max_requests = 600
```

When deploying with Docker or systemd for the first time, supply bootstrap admin credentials once via `AGENT_VELA_RELAY_ADMIN_USERNAME` and `AGENT_VELA_RELAY_ADMIN_PASSWORD`, or run `agent-vela-relay admin init` interactively. Empty or placeholder passwords are rejected, and bootstrap credentials can be removed from the environment after initialization.

## Deploying on Linux

### Docker Compose + Caddy (Recommended)

Use [`apps/relay/docker-compose.yml`](../../apps/relay/docker-compose.yml) and [`apps/relay/Caddyfile`](../../apps/relay/Caddyfile) to build `agent-vela-relay` + `@t3tools/web`, terminate TLS with automatic HTTP-01 certificates, flush SSE/WebSocket streams cleanly (`flush_interval -1`), and persist SQLite WAL state in a volume:

```sh
AGENT_VELA_RELAY_ADMIN_USERNAME=admin \
AGENT_VELA_RELAY_ADMIN_PASSWORD=replace-with-long-secret \
docker compose -f apps/relay/docker-compose.yml up -d --build
```

### Nginx Reverse Proxy

If terminating TLS in an existing Nginx instance, disable buffering so SSE streams (`/v1/events`, thread streams) and long-lived WebSocket tunnels (`/v1/tunnel/connect`, `/e/:endpointKey/...`) do not stall or time out:

```nginx
server {
  listen 443 ssl http2;
  server_name relay.example.com;

  # ssl_certificate / ssl_certificate_key ...

  client_max_body_size 64m;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

Define `$connection_upgrade` in `http {}` (`map $http_upgrade $connection_upgrade { default upgrade; '' close; }`) so normal HTTP requests keep keepalive pooling instead of forwarding `Connection: upgrade` unconditionally.

### Standalone Node.js + systemd

Install the workspace checkout under `/opt/agent-vela-relay`, build the web UI (`vp run --filter @t3tools/web build`) if `serve_web_ui = true`, and use the hardened [`agent-vela-relay.service`](../../apps/relay/agent-vela-relay.service) unit under a dedicated unprivileged account pointing at `/etc/agent-vela-relay/relay.toml`:

```sh
node --experimental-strip-types apps/relay/src/bin.ts serve --config /etc/agent-vela-relay/relay.toml
```

## Admin Operations

Administrators manage accounts, invite codes, and connected tunnels from either the server CLI (`node --experimental-strip-types apps/relay/src/bin.ts ...`) or the `role=admin` panel in Web and Desktop Settings:

- **Bootstrap & users:** `agent-vela-relay admin init`, `admin user list [--json]`, `admin user create --username <u> --password <p> [--role admin|member]`, `admin user <enable|disable> <userId|username>`.
- **Invite codes:** `agent-vela-relay admin invite list [--json]`, `admin invite create [--role admin|member] [--uses <n>] [--ttl-hours <h>]`, `admin invite revoke <inviteId>`.
- **Live tunnels:** `agent-vela-relay admin tunnels list [--url <url>] --token <bearer> [--json]` (or `AGENT_VELA_RELAY_ADMIN_TOKEN`) shows `runId`, heartbeat RTT, active mux streams, and cumulative bytes in/out; `admin tunnels kick <environmentId> --token <bearer>` disconnects an active host session.
- **Web / Desktop Admin Panel:** visible when signed in with `role=admin`; exposes the same user/invite actions and live tunnel table.

## Enrolling AgentVela Hosts

Every host running `apps/server` connects outward to the relay using one of three paths:

- **Local UI:** open Settings in Desktop or local Web, enter `https://relay.example.com`, sign in, and enable relay linking for the local server.
- **Interactive CLI:** authenticate and link on machines with a terminal:

  ```sh
  agentvela relay login --url https://relay.example.com
  agentvela relay link
  agentvela relay status
  ```

- **Headless Linux / SSH / Docker:** mint a short-TTL one-time enrollment token from the Web or Desktop Settings page, then paste the generated command on the remote machine without exposing your account password:

  ```sh
  agentvela relay link --url https://relay.example.com --token <enroll-token>
  ```

Use `agentvela up --relay` (paired with [`agentvela service`](../../apps/server/src/cloud/bootService.ts)) to keep the host server and its outbound tunnel running across reboots, and `agentvela relay unlink` to revoke the host's relay registration.

## Connecting Clients & Transport Rules

- **Hosted Web UI:** when `serve_web_ui = true`, browse directly to `https://relay.example.com`; the UI reads its Relay URL from `window.location.origin`.
- **Desktop, Mobile, and local Web:** enter your Relay URL in Settings or on the sign-in screen (an optional build/env default can prefill it). Relay registration is single-active per client and never removes directly paired LAN, Tailscale, or SSH entries.
- **HTTPS enforcement:** public domains and public IP addresses require `https://`. Plain `http://` is accepted only for loopback (`localhost`, `127.0.0.1`), RFC1918 LAN addresses, and Tailscale ranges, with an explicit unencrypted-transport warning in the UI and CLI.

## Backup & Recovery

Relay state lives in `relay.sqlite` inside `data_dir` using SQLite WAL mode. Take hot backups using SQLite's online backup command so `-wal` frames are checkpointed safely:

```sh
sqlite3 /var/lib/agent-vela-relay/relay.sqlite ".backup /var/backups/relay-$(date +%F).sqlite"
```

If copying files manually instead, stop `agent-vela-relay` first and copy `relay.sqlite` alongside `-wal` and `-shm`. Refresh tokens and enrollment tokens are stored hashed, so restored backups never leak plaintext credentials; linked hosts automatically re-establish tunnels using their stored `environmentCredential` once the service restarts.
