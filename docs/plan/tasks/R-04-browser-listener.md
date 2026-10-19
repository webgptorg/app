# R-04. Browser listener: SNI routing, stream piping, flow control, limits

- **Lane:** Relay · **Module:** `apps/relay` · **Milestone:** M1
- **Depends on:** R-01, R-03 · **Unblocks:** X-01, R-05, I-01, I-05
- **Status:** todo
- **Spec:** Relay and tunnel (incl. Fairness and DoS); Interfaces (draft) 3 "Browser side"; Metadata we still see; Operations; ADRs: [0005](../../adr/0005-modular-architecture.md)

## Goal

One TCP listener on 443 that reads the SNI of each connection and either hands it to the relay's own TLS server (R-03) or pipes its raw bytes into the matching engine's tunnel, with flow control, limits and fairness. After this task a browser can reach an engine through the relay.

## Context

This is the relay's core promise: it routes ciphertext and never decrypts it. Everything here operates on bytes the relay cannot read beyond the ClientHello. The listener is also the relay's main DoS surface, so every resource an anonymous client can hold is bounded.

## Scope

- `src/domain/routing/route-connection.ts`: pure `routeConnection(parse: ClientHelloParse, ctx: { relayHostname, sessions: SessionTable }): RouteDecision` where `RouteDecision = { kind: 'own' } | { kind: 'engine'; session; hostname } | { kind: 'reject'; reason: 'no-sni' | 'malformed' | 'too-large' | 'unknown-host' | 'engine-offline' }`. The SNI is branded with C-01's `Hostname` parser first; failure is `malformed`. A well-formed hostname under the engine domain with no session on this relay is `engine-offline`; anything else unknown is `unknown-host`.
- `src/domain/limits/token-bucket.ts` (Clock-driven), `src/domain/limits/ip-limiter.ts` (concurrent connections and new connections per second per IP; IPv6 grouped by /64), `src/domain/limits/engine-limiter.ts` (concurrent streams, new streams per second, bandwidth in bytes per second per engine).
- `src/domain/routing/stream-scheduler.ts`: when several streams of one tunnel have data queued while the WebSocket is backed up, send in round-robin chunks so one large download cannot starve another stream's SSE or WebSocket.
- `src/domain/metrics/traffic-counters.ts`: bytes in and out per engine per UTC day, in memory, exposed for I-04. No per-connection records.
- `src/adapters/tcp-listener.ts`: `node:net` server. Per connection: check IP limits, start the ClientHello timer, feed chunks to `createClientHelloBuffer({ maxBytes: 16384 })` from `@ptbk/protocol` (R-01), route. `own`: `socket.unshift(buffered)` then R-03's `acceptSocket(socket)`. `engine`: check engine limits, `session.openStream(clientIp)`, send the buffered bytes as the first `DATA`, then pipe. `reject`: destroy the socket without sending anything.
- `src/adapters/socket-stream-pipe.ts`: socket to stream: read only while send credit is available (`socket.pause()` at zero, resume on `WINDOW`). Stream to socket: write `DATA`, and grant `WINDOW` credit back only after `socket.write()` drains. Either side closing sends `CLOSE` or ends the socket; errors destroy both without logging content.
- Config fields added: `RELAY_CLIENT_HELLO_TIMEOUT_MS` (default 5000), `RELAY_MAX_CONNECTIONS_PER_IP` (default 256), `RELAY_NEW_CONNECTIONS_PER_IP_PER_S` (default 50), `RELAY_MAX_STREAMS_PER_ENGINE` (default 1024), `RELAY_NEW_STREAMS_PER_ENGINE_PER_S` (default 200), `RELAY_ENGINE_BANDWIDTH_BYTES_PER_S` (default 12.5 MB/s), `RELAY_MAX_CONNECTIONS` (global). Defaults are starting points; R-05 tunes them.
- `start-relay.ts` now listens on `RELAY_LISTEN_PORT` with this dispatcher in front of R-03's TLS server.

## Out of scope

- Abuse-handling IP retention (24 h, not linked to accounts) and the takedown flow (I-05). Prometheus or other metrics export (I-04). Inter-relay forwarding.

## Design notes

- No idle timeout on established streams: SSE and WebSockets are long-lived. Enable TCP keepalive on browser sockets and rely on tunnel liveness; when a tunnel closes, destroy all its browser sockets.
- Rejected connections log nothing by default (spec: no access logs). Count rejects per reason in memory for I-04; never record the SNI of a rejected connection.
- Never write bytes to a rejected socket: no TLS alert, no HTTP error, so the relay does not act as a TLS endpoint for engine names.
- When the tunnel's WebSocket `bufferedAmount` passes a high-water mark, pause reading from all of that engine's browser sockets until it drains.

## Acceptance criteria

- [ ] `route-connection` unit tests: own hostname; known engine default hostname; verified custom hostname; well-formed engine hostname with no session (`engine-offline`); unrelated hostname; `no-sni`, `malformed`, `too-large` pass through as rejects; uppercase SNI routes like lowercase.
- [ ] Limiter tests with fake clock: token refill, per-IP concurrency release on close, IPv6 /64 grouping, per-engine stream cap.
- [ ] Integration test (real sockets, port 0): a fake engine built from `@ptbk/protocol` terminates TLS with a test certificate inside the stream; `node:tls` client connects with that SNI and exchanges 10 MB both ways intact; the relay process never has the engine's key (the test's key only lives in the fake engine).
- [ ] Integration tests: no ClientHello within the timeout closes the socket; plain HTTP on 443 is closed with zero bytes written; unknown SNI is closed with zero bytes written; the relay's own hostname still reaches `/healthz` and `/v1/tunnel` on the same port.
- [ ] Backpressure test: a browser client that stops reading does not grow relay memory past the window size; a second stream on the same tunnel keeps flowing (scheduler fairness).
- [ ] Killing the tunnel destroys its browser sockets; closing a browser socket sends `CLOSE` to the engine.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Browsers retry another DNS address only when TCP fails, not when an accepted connection closes. If an engine lacks a tunnel to one relay that DNS returns, some browsers fail. Failover therefore relies on engines holding tunnels to every relay (M-01) and on dead relays refusing TCP. X-02 measures this; flag findings rather than adding inter-relay forwarding here.
- Per-IP limits must not throttle CA validation (Let's Encrypt validates from several vantage points) or large NATs. Watch for it in M-03 and X-02.
