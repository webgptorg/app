# Security rules for this repo

The full model is in the [spec](spec/zero-trust-spec.md). This page lists what it means for code in this repo.

## Guarantees we must keep

| Guarantee                               | Where it is enforced                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The relay cannot read engine traffic    | `apps/relay` pipes bytes for engine SNIs; it holds no engine keys or certificates                                                                                         |
| A hostname routes only to its engine    | Default hostnames are derived from the engine key; custom ones need a claim signed by it and a customer DNS CNAME to that engine's default hostname, checked by the relay |
| The dashboard holds no engine content   | `apps/dashboard` schema: accounts, registry, heartbeat metadata, billing only                                                                                             |
| Heartbeats cannot be forged or replayed | Ed25519 over `ptbk-heartbeat-v1` and the SHA-256 of the raw body, increasing `seq`, `ts` within 2 minutes                                                                 |
| Our domains never load engine data      | No dashboard page fetches from an engine hostname                                                                                                                         |

Breaking any of these is a security bug. Changing one needs an ADR and sign-off from a maintainer.

## What we still see

Even with the guarantees above, the relay and the dashboard see metadata: client IPs, SNI, timing and volume, heartbeat fields. The spec lists it (Metadata we still see). Do not log more than that list, and keep relay logs short-lived.

## Code rules

- Every HTTP route goes through the typed route helper: strict input schemas, explicit `auth` mode, a permission for session routes, a rate limit for anonymous and machine routes; a route-table test enforces it ([engineering.md](engineering.md#request-handling-every-http-endpoint)).
- Roles and permissions are closed allowlists; deny by default; 404 for resources the actor may not see.

- No `eval`, `new Function` or `vm` (ESLint).
- zod at every boundary; schemas reject unknown fields.
- Secrets come from Workers secrets or the host environment, never from the repo. `.dev.vars` and `.env` are git-ignored.
- Random values only from `crypto.getRandomValues` (ESLint bans `Math.random`).
- Look secrets up by their SHA-256 hash, so timing is irrelevant. Where a direct comparison is unavoidable, compare SHA-256 digests with `crypto.subtle.timingSafeEqual` (Workers) or `crypto.timingSafeEqual` (Node).
- Verify Ed25519 with `@noble/curves` in strict mode, never ad hoc; build signature inputs only with `signingInput` ([ADR 0014](adr/0014-cryptography.md)).
- Rate-limit everything an anonymous client can reach (relay listeners, registration, heartbeat).

## Supply chain and CI

See [development.md](development.md#dependencies) and [development.md](development.md#ci).
