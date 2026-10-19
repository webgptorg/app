# 0002. Relay, dashboard and UI here; engine public

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

The spec's first build plan put the relay and the protocol in the public `promptbook` monorepo and only the dashboard here. The relay, the dashboard and the full app UI are the commercial part; the engine must stay open source so customers can audit what runs on their servers.

The zero-trust argument does not depend on the relay's code: the relay only ever sees TLS ciphertext, which is verifiable from the public engine and a packet capture. The UI is covered by [ADR 0003](0003-ui-as-signed-bundle.md).

## Decision

- **Private, here:** relay, dashboard, engine-ui, mock engine, end-to-end tests, infra.
- **Public, `webgptorg/promptbook`:** the engine and everything that runs on the customer's server: tunnel client, ACME, UI loader, updater, pre-auth gateway, engine API, release tooling. Built by the engine team against our specs.
- **Contracts** (`protocol`, `engine-api`, `conformance`) have **one source of truth**. They start here, MIT-licensed, with no private code or dependencies, so they can iterate quickly with the relay and the mock engine. Before the real engine depends on them, they move to the public repo (or are published to npm with provenance) and this repo consumes the published version. There are never two copies that must be kept in sync.

## Consequences

- The engine team integrates last, against stable contracts and a passing conformance suite ([ADR 0004](0004-mock-engine-and-conformance.md)).
- ESLint keeps the contract packages portable: `protocol` and `engine-api` import nothing from `@ptbk/*`, and `conformance` imports only those two, so moving them is a copy, not a refactor.
- Relay federation with independent operators (spec roadmap, later) will need the relay, or a reference implementation, to be shareable. Revisit then.
