# Self-hosted relay troubleshooting

A self-hosted relay connection goes through four parts, in this order:

1. **This device** reaches your `agent-vela-relay` server over HTTPS or WSS.
2. **Your relay (`agent-vela-relay`)** verifies your relay session and forwards requests to the host's tunnel.
3. **The host's outbound WSS tunnel** (`/v1/tunnel/connect`, run in-process by `RelayTunnelClient`) carries the stream to the host.
4. **AgentVela on the host** (`apps/server`) verifies DPoP proofs and answers.

When a connection fails, open **Settings → Environments**, find the environment, and select **Details**. The first step marked as failed points to the cause.

On the host, run `agentvela relay status` (or `agentvela relay status --json`) to inspect local registration (`linked`, `relayUrl`, `endpoint`) and tunnel state (`connected`, `reconnecting`, `disconnected`, `runId`, `rttMs`, `activeStreams`, `lastError`).

## The host's tunnel is offline

The relay does not have an active outbound tunnel from the host. Common causes:

- The host is asleep, powered off, or disconnected from the internet.
- AgentVela (`apps/server` or desktop app) is not running on the host.
- Outbound WSS traffic from the host to `<relay-url>/v1/tunnel/connect` is blocked by a firewall, proxy, or exit node.

Fix:

1. Make sure the host is awake and AgentVela is running.
2. On the host, run `agentvela relay status` to see `lastError` and reconnect backoff state.
3. On the relay server, verify `GET https://<your-relay-domain>/health` returns HTTP 200 and run `agent-vela-relay admin tunnels list --url <relay-url> --token <admin-token>` (or check the Admin panel in Web/Desktop Settings).
4. If you cannot reach the relay from a restricted network, add a direct route such as a LAN or Tailscale address. See [Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways).

## Streams hang or WebSocket connections drop

When `/v1/events` or `/e/:endpointKey/...` streams stall behind a reverse proxy:

- **Caddy:** ensure `flush_interval -1` is set in [`apps/relay/Caddyfile`](../../apps/relay/Caddyfile).
- **Nginx:** ensure `proxy_buffering off`, `Upgrade` / `Connection` WebSocket headers, and long `proxy_read_timeout` / `proxy_send_timeout` values (e.g. `3600s`) are configured as shown in [Self-Hosted Relay Setup](../operations/02_connect-setup.md).
- **Rate limits (`429`):** check `[rate_limit]` thresholds and ensure `[server].trust_proxy = true` in `relay.toml` when running behind Caddy or Nginx so limits apply per client IP rather than the proxy IP.

## The tunnel works, but AgentVela does not answer

The host is connected to the relay, but requests to the local server fail or time out. Common causes:

- AgentVela on the host crashed, stopped, or is still starting.
- A stale tunnel session was left open after an ungraceful disconnect.

Fix: restart AgentVela on the host (`agentvela service restart` for the background service), then run `agentvela relay status`. If an older session is stuck on the relay, kick it with `agent-vela-relay admin tunnels kick <environmentId> --token <admin-token>` (or click disconnect in the Admin panel).

## Sign-in, account, or link problems

- **The host is linked to a different relay user or server.** On the host, run `agentvela relay unlink` and `agentvela relay logout`, then `agentvela relay login --url <relay-url>` and `agentvela relay link`.
- **The relay URL is rejected on HTTP.** Public domains and public IPs require `https://`. Plain `http://` is permitted only for loopback (`localhost`, `127.0.0.1`), RFC1918 LAN addresses, and Tailscale ranges.
- **The host is waiting for device approval.** If `requireConnectDeviceApproval` is enabled, approve the displayed code from an already-connected device or run `agentvela auth connect-device approve <code>` on the host. See [Approve new devices](./remote-access.md#approve-new-devices).
- **Clock skew breaks DPoP or Ed25519 proofs.** Turn on automatic date and time on both client and host machines.

## Common relay errors

| Error                                | Fix                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth_invalid` or `invalid_bearer`   | Run `agentvela relay login --url <relay-url>`. If the host link was revoked, run `agentvela relay unlink` then `agentvela relay link`, and restart. |
| Expired or invalid link proof        | Sync date/time on host and relay, then run `agentvela relay status`.                                                                                |
| HTTP 403 on an environment route     | Approve the new device key if device approval is enabled, or check whether the user/session was disabled in the Admin panel.                        |
| HTTP 429 on login or proxy           | Check `[rate_limit]` and `trust_proxy = true` in `relay.toml`.                                                                                      |
| `502 Bad Gateway` from reverse proxy | Confirm `agent-vela-relay` is running on its configured `bind` port (`GET /health`).                                                                |

If AgentVela stops on the host when SSH disconnects, see [background-service troubleshooting](./background-service.md#troubleshooting).

## Report a problem

If none of this helps, open an issue on [GitHub](https://github.com/redwolf2019/AgentVela/issues). Redact tokens, passwords, and private URLs, and include:

- The text from **Copy diagnostics** in the environment's **Details**.
- The output of `agentvela relay status` on the host and `GET /health` from the relay.
- Relevant logs from `relay.sqlite` host status (`journalctl -u agent-vela-relay` or `docker compose logs relay`) and `~/.agentvela/userdata/logs/server.trace.ndjson` on the host.
