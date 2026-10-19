# X-02. Spike network tests: NAT, 443-only, proxies, failover, packet capture

- **Lane:** X · **Module:** `e2e/` · **Milestone:** M1
- **Depends on:** X-01 · **Unblocks:** — (closes M1 together with M-03 and R-05)
- **Status:** todo
- **Spec:** Build plan (Spike acceptance criteria), Relay and tunnel (proxy, failover), Interfaces (3 tunnel protocol), Security goals (Confidentiality); ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md)

## Goal

Every network criterion of the spike runs as an automated e2e test: engine behind NAT with no inbound path, egress limited to 443, through an HTTP CONNECT proxy, through a TLS-inspecting proxy, relay restart and relay loss, and a packet capture proving the relay sees only TLS records and holds no engine key.

## Context

These tests are the evidence behind the zero-trust claim for the relay and the M1 gate. Each scenario is a compose overlay on X-01's stack. Each one also has a negative control that proves the restriction is real, because a firewall test that passes with the firewall missing proves nothing.

## Scope

- Topology for every scenario: the mock engine sits on an `internal: true` network (`engine-lan`) with no route out except through a `gateway` container (`NET_ADMIN`) doing NAT. The browser, relays and DNS stay on the public network. Overlays in `e2e/compose.<scenario>.yaml`, tests in `e2e/tests/network/`.
- **NAT, no inbound:** the gateway masquerades outbound traffic and forwards nothing inbound. Tests: the page loads through the relay; from the `playwright` container, connecting to the engine's address on any port fails (negative control).
- **Egress only 443:** gateway `iptables` allows outbound TCP 443 (and DNS to the internal resolver), drops everything else. Tests: the page loads; a probe container on `engine-lan` cannot reach a relay on another port (negative control).
- **HTTP CONNECT proxy:** a forward proxy (Squid or tinyproxy, pinned by digest) is the engine's only way out; the engine gets `HTTPS_PROXY`. Tests: the page loads; the proxy log shows `CONNECT relay-a.ptbk.test:443` and `relay-b…`; with the proxy stopped the tunnels drop (negative control).
- **TLS-inspecting proxy:** mitmproxy (pinned by digest) as `HTTPS_PROXY`, its CA trusted by the engine through `NODE_EXTRA_CA_CERTS` (as a corporate client would). Tests: the page loads; the browser's peer certificate fingerprint equals the engine certificate; mitmproxy's flow dump shows the intercepted WebSocket to the relay (proving inspection happened) and its binary messages carry TLS records, not HTTP.
- **Relay restart:** `docker compose restart relay-a`; the time from the relay being healthy again to the mock engine reporting the relay-a tunnel ready is under 10 s. Run three times; all three must pass. Report the times in the test output.
- **One of two relays killed:** for each relay in turn, `kill` it (process gone, port refused) and also `pause` it (blackhole); a fresh browser context loads the engine page through the other relay. Assert success and record the time; fail above 15 s.
- **Packet capture:** a `tcpdump` sidecar in relay-a's network namespace (`network_mode: service:relay-a`, `NET_RAW`) captures port 443 while the browser loads the spike page, runs SSE and a WebSocket exchange. The mock engine's spike page contains a random canary generated per run. A TypeScript analyser in `e2e/src/pcap/` (reads pcap, reassembles TCP streams) asserts:
  - every browser-to-relay stream for the engine hostname is a sequence of well-formed TLS records (types 20 to 23), with only application data after the handshake;
  - the canary, `HTTP/1.1`, `GET /` and the SSE event names never appear in plaintext in the capture.
- **Relay holds no engine key:** scan relay-a's filesystem and environment (`docker compose exec` plus `docker inspect`) for the engine private key (raw, base64url, PEM, DER), the engine TLS key and the engine certificate; assert none is present and only the relay's own key exists.

## Out of scope

- ACME TLS-ALPN-01 (M-03). Screencast throughput and bandwidth (R-05 or a follow-up; see Risks). Load (R-05).
- Real Let's Encrypt staging certificates (M-03 runs against Pebble).

## Design notes

- The pcap analyser is a pure module with unit tests on fixture captures generated in the test itself (no committed captures containing keys).
- Timings use the event timestamps the services log (relay healthy, tunnel ready), not wall-clock sleeps; poll with `expect.poll` at 100 ms.
- Firewall rules live in a script in `e2e/gateway/` with comments on why each rule exists.

## Acceptance criteria

- [ ] Each scenario above is a separate Playwright test file and passes in the CI `e2e` job.
- [ ] Each negative control exists and fails when its restriction is removed (verified once, noted in the PR).
- [ ] Restart test prints three reconnect times, all under 10 s.
- [ ] Failover test passes for both relays, in both kill and pause variants.
- [ ] Packet capture and key-scan tests pass; the analyser has unit tests for record parsing, stream reassembly and canary detection, including a positive case where plaintext is present.
- [ ] The plan's M1 row can tick every spike network criterion; [development.md](../../development.md) lists how to run one scenario alone.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The pause (blackhole) variant depends on how fast Chromium gives up on the first address; if it exceeds 15 s, record the value and raise it with the team rather than loosening the limit silently.
- Reconnect under 10 s depends on M-01's backoff schedule; if it caps too high, fix it in M-01.
- The spike criterion "screencast at 5 fps or better, bandwidth per hour measured" has no owner in the plan; suggest assigning it to R-05.
- A stronger check would decrypt the outer tunnel TLS with a relay test keylog and confirm the inner bytes are still TLS; it needs relay support and is optional.
