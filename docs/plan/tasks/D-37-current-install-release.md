# D-37. Current published engine installation

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M5
- **Depends on:** D-11
- **Status:** done (#352)
- **Spec:** [Engine-first installation](../../design/engine-first-installation.md)

## Goal

New installations follow the published npm `latest` release without redeploying Dashboard for every engine release. Command, AI, Ubuntu and Windows installation use one exact version and the matching Windows SHA-256.

## Scope

- Resolve official npm metadata on link-code issuance, for personal and team projects.
- Accept only supported semantic versions, never downgrade the configured release, and require the exact published GitHub release and Windows asset digest before promoting it.
- Keep the reviewed immutable Ubuntu bootstrap and the configured release as the bounded-time fallback. Local development and tests stay offline.
- Cover publication races, upstream errors, malicious metadata, future release lines and issuance integration with regression tests.

## Acceptance criteria

- [x] A later complete published release replaces the configured version in every installation option.
- [x] Invalid, incomplete, older or unavailable releases preserve the configured version and matching digest.
- [x] Both issuance routes use the resolver; legacy installations make no metadata requests.
- [x] Scoped lint, typecheck and tests pass; docs explain selection and fallback.
