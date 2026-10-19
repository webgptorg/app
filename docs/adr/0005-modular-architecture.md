# 0005. Modules with explicit contracts, ports and adapters inside

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

Every part of this system is expected to be swapped at some point: the mock engine for the real one, a relay provider, the registry source, the billing provider, maybe the tunnel framing (the spec allows yamux). Several agents will also build modules in parallel.

## Decision

- Each workspace package is a module with one public contract: a single `exports` entry for packages, a documented network interface for apps. Apps never import each other.
- Inside apps: `domain/` (pure logic and port interfaces), `adapters/` (implementations), `app/` (composition root). Dependencies are passed in explicitly; no DI container, no singletons.
- ESLint enforces the boundaries that matter: domain purity and portable contract packages. The isolated linker enforces declared dependencies.
- Details and TypeScript rules: [engineering.md](../engineering.md).

## Consequences

- Each port has an in-memory adapter, so modules are testable and runnable alone.
- Parallel work splits along module lines with few merge conflicts.
- A little more structure up front than a single script would need; worth it given the swaps we already know about.
