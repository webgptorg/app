# 0001. One monorepo with Bun workspaces

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

The private side has two deployables (relay, dashboard) and shared contracts. They change together while the protocol is young, and the team is small.

## Decision

One repo, Bun workspaces: `apps/*` for deployables, `packages/*` for shared code. Bun is the package manager and script runner; Node 24 LTS stays the runtime for the relay and for tooling, and the dashboard runs on Cloudflare Workers.

No task runner (Turborepo, Nx) for now: `bun run --filter` covers three packages. Add one when CI time says so.

TypeScript is held at 6.0 because typescript-eslint does not support TypeScript 7 yet.

## Consequences

- One lockfile, one CI, atomic changes across the protocol and its users.
- Supply-chain rules (7-day minimum release age, exact versions, blocked install scripts) apply everywhere through one `bunfig.toml`.
- Bun runs scripts, but code must not use Bun-only APIs (`Bun.*`, `bun:*`): the relay runs on Node and the dashboard on Workers.
