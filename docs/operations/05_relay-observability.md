# Relay Observability (`agent-vela-relay`)

[`agent-vela-relay`](../../apps/relay/package.json) exposes direct HTTP health probes, live per-tunnel admin telemetry, and host-side CLI diagnostics with zero third-party telemetry collectors required.

## Built-in endpoints and CLI inspection

- **Liveness (`GET /health`):** Unauthenticated endpoint returning `200` with JSON `{"ok": true, "service": "agent-vela-relay", "version": "<version>"}`. Use this as your Docker/load-balancer health check before blaming reverse proxy timeouts.
- **Live tunnel telemetry (`agent-vela-relay admin tunnels list` or Admin UI):** Queries `GET /v1/admin/tunnels` (authenticated with an admin bearer token) to inspect connected hosts: `environmentId`, `endpointKey`, owner `username`, monotonic `runId`, heartbeat `rttMs`, active mux streams, and cumulative `bytesIn` / `bytesOut`. Set `AGENT_VELA_RELAY_ADMIN_TOKEN` or pass `--token <bearer> [--json]`.
- **Host-side status (`t3 relay status [--json]`):** Inspects local relay registration (`linked`, `relayUrl`, `endpoint`) alongside `RelayTunnelClient` state (`connected`/`reconnecting`/`disconnected`, `runId`, `rttMs`, `activeStreams`, `lastError`).

## Common failure triage

- **Client requests return `502` or host shows `offline`:** Check `GET /health` on the relay, verify outbound WSS connectivity from the host to `/v1/tunnel/connect`, and run `t3 relay status` on the host machine for the latest `lastError` and reconnect backoff state.
- **Slow SSE event streams (`/v1/events`, thread output) or idle WebSocket drops:** Confirm reverse proxy buffering is disabled (`flush_interval -1` in [`Caddyfile`](../../apps/relay/Caddyfile) or `proxy_buffering off` in Nginx) and proxy timeouts exceed idle heartbeat intervals (`[tunnel].heartbeat_interval_seconds = 20`, `heartbeat_timeout_seconds = 60`).
- **Stale host session or misbehaving client tunnel:** Evict a single environment session without restarting the relay using `agent-vela-relay admin tunnels kick <environmentId> --token <bearer>` (or the Admin panel disconnect button).
- **Rate-limit `429` responses:** Check `[rate_limit]` thresholds (`login_max_attempts`, `dpop_max_attempts`, `proxy_max_requests`) in [`relay.toml.example`](../../apps/relay/relay.toml.example) and verify `[server].trust_proxy = true` when behind Caddy/Nginx so limits apply per client IP instead of the proxy address.
- **Process logs:** Under Docker use `docker compose -f apps/relay/docker-compose.yml logs -f relay`; under systemd use `journalctl -u agent-vela-relay -f`.
