# Architecture decision records

One file per decision. Copy [0000-template.md](0000-template.md), take the next number, and open the PR with status `Proposed`. Accepted ADRs are not rewritten; a new ADR supersedes them.

| ADR                                               | Decision                                                              | Status   |
| ------------------------------------------------- | --------------------------------------------------------------------- | -------- |
| [0001](0001-bun-workspaces-monorepo.md)           | One monorepo with Bun workspaces                                      | Accepted |
| [0002](0002-public-private-split.md)              | Relay, dashboard and UI here; engine public; one source for contracts | Accepted |
| [0003](0003-ui-as-signed-bundle.md)               | The UI is a private, signed bundle that the engine serves             | Accepted |
| [0004](0004-mock-engine-and-conformance.md)       | A mock engine and a conformance suite                                 | Accepted |
| [0005](0005-modular-architecture.md)              | Modules with explicit contracts, ports and adapters                   | Accepted |
| [0006](0006-organizations-and-roles.md)           | Organizations, members and roles from day one                         | Accepted |
| [0007](0007-frontend-stack.md)                    | One frontend stack: Vite SPAs on TanStack, shared design system       | Accepted |
| [0008](0008-hono-for-http-apis.md)                | Hono for every HTTP API; contracts stay framework-agnostic            | Accepted |
| [0009](0009-drizzle-and-migrations.md)            | Drizzle for D1, with generated and guarded migrations                 | Accepted |
| [0010](0010-protocol-design-principles.md)        | Protocol design principles                                            | Accepted |
| [0011](0011-infrastructure-as-code.md)            | Infrastructure as code: OpenTofu and cloud-init                       | Proposed |
| [0014](0014-cryptography.md)                      | Cryptographic primitives, encodings and libraries                     | Accepted |
| [0015](0015-ui-architecture-and-design-system.md) | UI architecture and design system                                     | Accepted |
| [0016](0016-engine-capabilities.md)               | Engine capabilities and a typed, extensible activity model            | Accepted |
| [0017](0017-billing-entitlements.md)              | Billing through entitlements                                          | Accepted |
