# R-06. Relay hardening: admission, memory, hostile engines, crash containment

- **Lane:** Relay · **Module:** `apps/relay`, `packages/protocol` (ClientHello reassembly only) · **Milestone:** M4
- **Depends on:** R-04
- **Status:** in progress (feat/r-06-protocol)
- **Spec:** Relay and tunnel (Fairness and DoS on a shared relay; No single point of failure); Security goals and threat model; Metadata we still see; Operations; ADRs: [0005](../../adr/0005-modular-architecture.md), [0010](../../adr/0010-protocol-design-principles.md), [0014](../../adr/0014-cryptography.md)

## Goal

The relay stays available under hostile browsers and hostile engines: no single party can exhaust its connections, memory or an engine's streams, keep a tunnel alive by abusing control frames, or crash the process, and the rule that the relay never decrypts cannot be broken by configuration. This task closes the findings of the relay security review of 2026-10-21.

## Context

The review found no way to read or forge traffic, impersonate or replay an engine, downgrade the negotiation or route a hostname to the wrong engine: confidentiality rests on end-to-end TLS and the signed handshake, not on relay code. Every finding was about availability, and the relay's availability is every customer's. Two attackers matter: anyone on the internet opening browser connections, and a **hostile engine**, because the engine is open source and anyone can run a modified one with a valid key. R-04 built the mechanics; this task closes the gaps. I-05 later sets the production values; R-05 measures the numbers they come from; I-01 does the host side.

## Scope

Every limit is a config value with a documented default, every refusal keeps writing zero bytes and stays indistinguishable from the others, and every refusal reason gets a counter for I-04.

- **Admission before the ClientHello** (`tcp-listener.ts`, `ip-limiter.ts`):
  - Connections that have not completed a ClientHello get their own budget (default 25% of the global cap). Above 80% of it, the ClientHello timeout drops to 1 s and a new connection evicts the oldest pending one instead of being refused.
  - IPv6 is counted at /64, /56 and /48, each with its own cap; IPv4 per address.
  - A reserve of the global cap (default 10%) is kept for the relay's own hostname: a connection is admitted against global plus reserve and re-checked once its SNI is known, so browsers can never use the reserve and engines can always reconnect.
- **Stream lifetime** (`socket-stream-pipe.ts`, `tcp-listener.ts`):
  - The IP admission and the `held` entry are released when the stream ends, not when the socket closes.
  - After a browser FIN with data still waiting for engine credit, a drain deadline (default 30 s), then RESET.
  - After the engine closes a stream: stop reading into it (remove the data listener, discard incoming bytes, ignore late data), and destroy the socket after an end timeout.
  - A stream that receives no bytes from the engine within 10 s of `OPEN` is reset, so idle ClientHellos cannot fill an engine's stream slots.
- **Memory budget:** one relay-wide byte budget over everything buffered (bytes waiting for engine credit, queued frames, each socket's `writableLength`). Over budget, the relay stops returning credit and stops reading from browsers (backpressure) and refuses new browser connections with `memory-limit`. The default comes from R-05 when it exists; otherwise size it for the 4 GB reference host.
- **Hostile engine, control plane** (`ws-tunnel-transport.ts`, `own-tls-server.ts`):
  - `autoPong: false`: the relay answers pings itself and terminates the tunnel when `bufferedAmount` exceeds a cap (default 1 MiB).
  - Relay pings carry a random 8-byte payload; only a pong echoing it resets the liveness deadline.
  - `transport.send` terminates the tunnel when `bufferedAmount` exceeds a hard cap (default 8 MiB).
  - `closeTimeout` about 2 s; `maxFragments` and `maxBufferedChunks` (ws 8.21+) sized to one frame.
- **Hostile engine, frames** (`tunnel-session.ts`): a per-tunnel frame budget (token bucket) counting every frame, including ignorable ones and `CLOSE` for old streams; WINDOW increments below a minimum (default 1 KiB, unless they open a window that was fully closed) are coalesced before the relay sends DATA, so 1-byte grants cannot make it send 1-byte frames. Exceeding the budget closes the tunnel with C-02's policy close code; if none fits, add one by addition (ADR 0010).
- **Handshake limits** (`tunnel-endpoint.ts`, `handshake-limiter.ts`, `session-table.ts`):
  - A slot is freed when the socket closes, not when `reject` or `close` is sent; the socket is terminated about 1 s after `reject`.
  - The handshake limiter and the session table's per-IP counts key on `ipLimitKey` (/64), like `ip-limiter`.
  - A global token bucket for registry lookups that miss the cache (default 20 per second, separate from revalidation's budget); empty means `rate-limited`.
- **Revalidation** (`revalidation.ts`, `cached-registry.ts`, `start-relay.ts`): rounds look up past the cache (`{ fresh: true }`), so a suspension takes effect within one TTL; SIGHUP clears the registry cache and runs a round. Fix the comment that claims rounds already bypass the cache.
- **ClientHello reassembly** (`packages/protocol/src/tls/client-hello-buffer.ts`): keep parse state between chunks and re-parse only once the current record is complete; refuse after 64 chunks without a complete hello (real browsers use one to three); raise the hello limit to 32 KiB across records, excluding record headers, for post-quantum key shares.
- **Crash containment:** ws event handlers and timers in the session and pipe code run through a guard like `tcp-listener`'s `guarded`, closing the tunnel with `PROTOCOL_ERROR` and logging. Every listening server keeps a permanent `error` listener and sets `maxConnections`. `main.ts` handles `uncaughtException` and `unhandledRejection` by logging and exiting non-zero (systemd restarts the relay, I-01); it never continues in an unknown state.
- **"Never decrypts" in config:** config rejects a `RELAY_HOSTNAME` inside `RELAY_ENGINE_DOMAIN`; at startup the relay reads its certificate's SANs with `X509Certificate` and refuses to start if any equals or covers the engine domain or a name under it.
- **Relay certificate:** SIGHUP reloads it into a fresh secure context without dropping tunnels; session tickets are disabled on the relay's own listener (tunnels are long-lived, so resumption buys nothing and ticket keys never rotate otherwise).
- **Verification beyond unit tests:**
  - A fast-check model-based test (`fc.commands`) of `createTunnelSession` and the socket pipe against random engine frame sequences (DATA, WINDOW, CLOSE, ignorable, unknown stream IDs): never throws, buffered bytes stay within the window times open streams, any violation closes the session.
  - A property test that random bytes split into random chunks give the same ClientHello verdict as one-shot parsing.
  - Coverage-guided fuzzing with Jazzer.js on `createClientHelloBuffer` and `decodeFrame`, run nightly in its own workflow, not in PR CI. If Jazzer.js needs install scripts outside `trustedDependencies`, stop and ask (AGENTS.md).

## Out of scope

- Production values for the limits (I-05), measurements (R-05), host, kernel, firewall and resolver hardening (I-01), the external audit (see the plan's "Still needed").

## Design notes

- Limits live in the domain (`domain/limits/`) as pure logic with the injected `Clock`; adapters only report events and apply decisions.
- Evicting a pending connection, terminating a tunnel and refusing a connection all log a reason counter only: no IPs, hostnames or engine IDs in logs.
- A stricter limit must never turn a legitimate engine reconnect storm (after a relay restart) into a lockout: the reserve and the handshake limits are tested together with a reconnect storm.
- **Accepted deviation (Seb, 2026-10-22):** the memory budget charges each stream its maximum at admission (its window towards the browser plus one read towards the engine) instead of only the bytes it holds. A stream that does not fit is refused with `memory-limit`, so browsers that stop reading cannot hold back those that read; the cost is fewer concurrent streams per budget than measured usage alone would allow.
- **Deferred (Seb, 2026-10-22):** Jazzer.js fuzzing and its nightly workflow are not part of the R-06 PRs.

## Acceptance criteria

- [ ] Pre-ClientHello flood from many IPv4 addresses and from many /64s inside one /48: legitimate browsers are still admitted (eviction), and an engine reconnects through the reserve.
- [ ] A browser FIN during an in-flight batch with an engine that never grants credit keeps the IP slot held until the stream ends, and the drain deadline resets the stream.
- [ ] Data, and data followed by FIN, arriving after the engine's `CLOSE` release the socket.
- [ ] A stream with no engine bytes for 10 s after `OPEN` is reset.
- [ ] Many slow-reading browsers keep total buffered bytes under the memory budget, and new browser connections are refused with `memory-limit` while over it.
- [ ] Ping flood from a peer that does not read, before and after auth: the tunnel is terminated at the buffer cap; an unsolicited or non-echoing pong does not reset liveness.
- [ ] A hostile engine sending 1-byte WINDOW grants, a stream of ignorable frames, or `CLOSE` for old stream IDs is throttled or closed by the frame budget, and DATA frames toward it are never smaller than the minimum increment unless the window was closed.
- [ ] Handshake slots stay held while a refused socket is closing; IPv6 /64 handshake limits apply; cache-miss lookups beyond the bucket get `rate-limited`.
- [ ] An engine connected mid-interval is cut within one TTL of being suspended; SIGHUP clears the cache and triggers a round.
- [ ] A 16 KiB ClientHello in 1-byte chunks is refused after 64 chunks, and parsing time per chunk does not grow with the bytes received.
- [ ] A throw inside a session or pipe handler closes only that tunnel; a server accept error does not crash the process; an uncaught error exits non-zero.
- [ ] Startup fails for a relay hostname inside the engine domain and for a certificate whose SANs cover it.
- [ ] Certificate reload on SIGHUP keeps existing tunnels connected; session tickets are disabled.
- [ ] The model-based test, the chunked-parse property test and the nightly fuzz workflow exist and pass.
- [ ] Coverage of the changed security code stays at or above 90% lines and branches.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Per-IP caps hurt many users behind one corporate IPv4 address; R-05 and I-05 tune them, and the reasons are counted so tuning is evidence-based.
- The engine side must cooperate: send WINDOW increments of at least the minimum and time out TLS handshakes it does not complete. Add both to the engine integration guide (E-01) and, when the conformance suite covers the tunnel, to C-05.
- The task is large; it may land as several PRs (admission and streams; memory; tunnel control plane and frames; the rest), each with `Refs: R-06`.
