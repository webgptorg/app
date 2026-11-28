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
| [0011](0011-infrastructure-as-code.md)            | Infrastructure as code: OpenTofu and cloud-init                       | Accepted |
| [0012](0012-monitoring-backend.md)                | Monitoring backend: Cloudflare first, no new vendor                   | Accepted |
| [0013](0013-book-editor.md)                       | Book editor: CodeMirror 6 in a shadow root                            | Accepted |
| [0014](0014-cryptography.md)                      | Cryptographic primitives, encodings and libraries                     | Accepted |
| [0015](0015-ui-architecture-and-design-system.md) | UI architecture and design system                                     | Accepted |
| [0016](0016-engine-capabilities.md)               | Engine capabilities and a typed, extensible activity model            | Accepted |
| [0017](0017-billing-entitlements.md)              | Billing through entitlements                                          | Accepted |
| [0018](0018-teams-and-member-access.md)           | Teams, access requests and dashboard removals                         | Proposed |
| [0019](0019-live-sessions-inside-the-tunnel.md)   | Live audio, video and the browser tab ride inside the engine's TLS    | Accepted |
| [0022](0022-usage-data-in-d1.md)                  | Usage data in D1: closed events and daily rollups, no engine content  | Accepted |
| [0023](0023-owner-setup-handoff.md)               | Owner setup handoff from the pairing browser                          | Accepted |
| [0026](0026-teams-v2.md)                          | Teams v2: departments with team admins and several projects           | Accepted |
| [0027](0027-notifications.md)                     | Notifications: one system, in-app and email, counts only from engines | Accepted |
| [0028](0028-clean-removal.md)                     | One "Remove project", an engine that knows, and a signed unlink       | Accepted |
