# Promptbook Platform

The commercial, private half of the Promptbook zero-trust interface: the **relay** that carries encrypted traffic to engines, the **dashboard** at app.ptbk.io, and the **engine UI** that engines download as a signed bundle and serve themselves.

The **engine** is open source in [`webgptorg/promptbook`](https://github.com/webgptorg/promptbook). It holds all data and keys; nothing in this repo can read engine content. Until the real engine integrates, a **mock engine** here speaks the same contracts. See [docs/architecture.md](docs/architecture.md).

## Layout

| Path                   | What                                                                | Runs on             |
| ---------------------- | ------------------------------------------------------------------- | ------------------- |
| `apps/relay`           | SNI passthrough relay and engine tunnel endpoint                    | Node 24 on VPSs     |
| `apps/dashboard`       | app.ptbk.io: sign-up, engine list, registry API, heartbeat, billing | Cloudflare Workers  |
| `apps/engine-ui`       | The full app UI, delivered as a signed bundle the engine serves     | Browser, via engine |
| `apps/mock-engine`     | Stand-in engine with seeded fake data, for development and tests    | Node 24             |
| `packages/protocol`    | Wire contracts between engine, relay and dashboard (MIT)            | Everywhere          |
| `packages/engine-api`  | Engine HTTP API contract and typed client (MIT)                     | Everywhere          |
| `packages/conformance` | Test suite any engine must pass (MIT)                               | CI                  |
| `infra`                | Relay hosts, DNS, Cloudflare resources                              | —                   |
| `docs`                 | Architecture, engineering guide, ADRs, implementation plan, spec    | —                   |

## Quick start

```sh
nvm use            # Node 24, from .nvmrc
bun install        # also installs the git hooks
bun run check      # lint, format check, typecheck, tests
```

## Where to go next

- [AGENTS.md](AGENTS.md): how to work in this repo (humans too).
- [docs/plan/README.md](docs/plan/README.md): the implementation plan and task status.
- [docs/engineering.md](docs/engineering.md): module design and TypeScript rules.
- [docs/development.md](docs/development.md) and [docs/conventions.md](docs/conventions.md): setup, dependencies, CI, commits.
