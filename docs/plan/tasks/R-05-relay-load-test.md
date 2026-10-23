# R-05. Relay load and throughput test

- **Lane:** Relay · **Module:** `apps/relay` (load tooling in `apps/relay/load/`) · **Milestone:** M1
- **Depends on:** R-04, M-01
- **Status:** in progress (feat/r-05-relay-load-test)
- **Spec:** Build plan (Spike acceptance criteria; v0 epics "Relay"); Operations (Bandwidth and cost); Hosting and stack; ADRs: [0005](../../adr/0005-modular-architecture.md)

## Goal

Measured, repeatable numbers for the relay: memory and CPU per idle tunnel at 1,000 tunnels on a small-VPS-sized container, and throughput, latency and bandwidth per hour for a screencast-shaped stream at 5 fps or more. Results are written down and the R-04 default limits are tuned from them.

## Context

The spec's relay epic is done when "a load test sustains 1,000 idle tunnels on one small VPS (target to confirm)", and the spike must run the screencast "at 5 fps or better, with bandwidth per hour measured". The spec guesses 2–5 GB per hour for a screencast and says the relay could be rewritten in Go if memory per connection ever matters. This task replaces those guesses with data. The relay is under test, not the engine, so the load generator plays the engine side itself.

## Scope

- `apps/relay/load/` (dev-only, excluded from the production bundle): a load generator in TypeScript run with tsx.
  - `idle-tunnels.ts`: generates N Ed25519 identities at run time (never committed), writes a static registry file for the relay, opens N tunnels using `@ptbk/protocol` and `ws`, holds them for a set duration with normal pings, and reports handshake rate, failures and reconnects.
  - `screencast.ts`: one or more simulated engines terminate TLS (`node:tls`, test certificate generated at run time) inside tunnel streams and serve a WebSocket that pushes frames of a set size at a set fps; a client through the relay counts frames, measures end-to-end latency (timestamp in each frame) and bytes.
  - `docker-compose.load.yml`: the relay built with R-02's production bundle in a container capped at **2 vCPU and 4 GB RAM** (Hetzner CX22-class; the "small VPS" to confirm), the generator in a separate uncapped container.
  - Sampling of relay RSS, heap and CPU every 5 s via `docker stats` or `/proc`, written as CSV next to the report.
- `worst-case.ts`: slow-reading browsers against engines serving large responses, and a pre-ClientHello flood; reports relay RSS (heap and off-heap) per connection, so the global connection cap and R-06's memory budget can be sized for the 4 GB container.
- `docs/perf/relay-load-test.md`: method, hardware, Node version, relay commit, raw tables, conclusions and recommended limits. Charts optional.
- Adjust R-04 and R-03 default limits in `config.ts` where the numbers say so, in the same PR.

## Out of scope

- Running against production or staging hosts (I-01 can repeat it there). Optimising the relay beyond fixes for problems this test finds; larger rewrites become their own task.
- The real engine's screencast encoder. Frame sizes here are assumptions, stated in the report.

## Design notes

- Scenarios, each run at least 10 minutes after warm-up:
  1. **Idle:** 1,000 tunnels, no streams. Report RSS per tunnel (total minus baseline, divided by N), CPU at rest, and time to establish all 1,000. Also run 2,000 and 5,000 if the 1,000 run passes, to find the ceiling.
  2. **Reconnect storm:** restart the relay with 1,000 engines connected; report time until all are back (spike: one tunnel within 10 s) and peak CPU.
  3. **Screencast:** frame sizes 50, 100 and 200 KB at 5 and 10 fps, 1 and 20 concurrent streams, with 1,000 idle tunnels in the background. Report achieved fps, p50/p95/p99 frame latency, relay CPU, and bytes per hour per stream (measured on the relay's network interface, so WebSocket and frame headers are included).
  4. **Fairness:** one engine saturating its bandwidth limit while another runs a 5 fps screencast; the second must keep its fps.
- Per-IP limits are raised through config for the generator's single IP; say so in the report.
- Keep the generator honest: it must respect `WINDOW` credit exactly as M-01 does, or the numbers flatter the relay.

## Acceptance criteria

- [ ] `bun run --filter @ptbk/relay load:idle` and `load:screencast` run the scenarios against the containerised relay with one command each, documented in the report.
- [ ] Report in `docs/perf/relay-load-test.md` includes: RSS per idle tunnel, CPU at 1,000 idle tunnels, reconnect-storm recovery time, a screencast table (frame size by fps by concurrency: achieved fps, latency percentiles, GB per hour), the fairness result, the worst-case memory per connection with the recommended global cap and memory budget, and the tested limits.
- [ ] 1,000 idle tunnels hold for 10 minutes on the capped container with zero unexpected disconnects, or the report states the measured ceiling and what limits it.
- [ ] A single 100 KB, 5 fps screencast stream sustains at least 5 fps with p95 latency under 500 ms while 1,000 idle tunnels are connected, or the report explains why not.
- [ ] Default limits in the relay config match the report's recommendations.
- [ ] `bun run check` passes (load scripts are typechecked and linted, but not run in CI).
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- "Small VPS" and "1,000 tunnels" are spec targets to confirm. If the numbers fall short, report them and propose a target; do not lower the bar silently.
- The screencast GB-per-hour figure feeds the cost model (Operations). Once the real engine exists, rerun scenario 3 with its actual frames (E-03).
- Docker's network on a laptop is not a VPS NIC. Note the host, and treat absolute throughput as a lower bound.
