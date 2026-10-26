# C-10. UI loader conformance suite

- **Lane:** Contracts · **Module:** `packages/conformance` (plus minimal changes in `packages/engine-api` and `apps/mock-engine`) · **Milestone:** M5
- **Depends on:** C-05, C-08, C-09, M-05
- **Status:** done (#86)
- **Spec:** Architecture (UI delivery); Interfaces (draft) 5 and 6; Residual risks (2. Engine updates); Security hardening 5, 9 and 10; ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md), [0004](../../adr/0004-mock-engine-and-conformance.md), [0014](../../adr/0014-cryptography.md)

## Goal

The `ui-loader` conformance suite checks an engine's UI loader black-box: a fake release store serves releases, artifacts and revocation lists built on the fly, the suite restarts the engine with different settings and reads what it serves and what its security panel reports. It passes against the mock engine, and every check is shown to fail against a deliberately broken loader.

## Context

The UI loader is the engine's most security-critical component: it decides which JavaScript runs on the engine's origin (zero-trust rule 3, ADR 0003). The engine maintainer implements the protocol with the conformance suite as the executable definition of done, and C-05 only registered the loader's check IDs as `skip`. The mock engine's loader (M-05) and the UI release tooling (X-03) are the reference; the suite may not import them (it imports only `@ptbk/protocol` and `@ptbk/engine-api`).

Black-box testing needs releases the engine accepts: signed by test release keys, with provenance under a test trust root, log inclusion, trusted time and a fresh revocation list. A production engine must never take a trust root or key from its environment, because whoever controls the environment or a mirror would then choose the code on the engine's origin.

### Test trust: a conformance build (decided 2026-10-26, Seb, through the coordinator)

Options weighed:

| Option                                                                                                           | Verdict                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trust policy and root from the environment, gated on `NODE_ENV` (what the mock does with `MOCK_UI_*`)            | Rejected for the real engine: the environment is not a trust boundary, and a gate on another variable is the same boundary.                                                                                         |
| A fake-provenance mode in the engine (test attestations, as `MOCK_UI_FAKE_PROVENANCE`)                           | Rejected: code that accepts unsigned attestations ships in the engine, and the engine's real Sigstore verifier, where identity pinning lives, is never tested.                                                      |
| The loader's verify function exposed for an in-process harness                                                   | Rejected as the main path: not black-box (fetching, persistence, restarts, unpacking, serving and headers stay untested) and tied to the engine's language.                                                         |
| **A conformance build: a build-time constant enables one trust override file; the suite mints Sigstore bundles** | **Chosen.** The only difference from production is where the trust policy and the Sigstore trusted root come from; the engine's own `@sigstore/verify` verifier, fetcher, state, unpacker and server run unchanged. |

The rules, normative for the engine ([ui-loader.md](../../engine-integration/ui-loader.md#testing-the-loader-conformance-build)):

1. A **conformance build** is the engine built with a compile-time constant (for example `PTBK_CONFORMANCE_BUILD=true` replaced at bundle time) that release builds set to `false`, so the code path is eliminated from them. Only that build reads `PTBK_CONFORMANCE_TRUST_FILE`: JSON `{ "v": 1, "trustPolicy": <C-06 TrustPolicy>, "trustedRoot": <Sigstore trusted_root.json> }`, parsed strictly. It replaces the pinned trust policy and the pinned trusted root, and nothing else.
2. A **production build** that sees `PTBK_CONFORMANCE_TRUST_FILE` set refuses to start, with an error naming the variable. It never silently ignores it, so a misconfigured deployment is noticed.
3. A conformance build is never releasable: the engine's release workflow asserts the constant is off in what it publishes. The build announces itself in its startup log, and in `GET /engine` or `GET /security` once the contract has a field for it (open point below).
4. The suite mints real Sigstore-format bundles under an ephemeral trusted root (Fulcio-style leaf certificate with the exact claims, embedded SCT, Rekor entry with signed entry timestamp and inclusion proof), so `ui-loader.provenance.*` exercises the engine's actual SAN and DER extension matching.

The mock engine accepts `PTBK_CONFORMANCE_TRUST_FILE` too (refused under `NODE_ENV=production`, like its other development switches), so the suite drives the mock and the real engine the same way.

### Driving and observing the engine

- **Trigger:** the engine checks for a UI update at startup (M-05 already does). The suite restarts it with new settings, mostly `PTBK_UPDATE_POLICY=pinned` and `PTBK_PINNED_VERSION`, because the 72 h delay is a schema literal and nothing installs under `auto` within a test run. No test endpoint is added.
- **Observe:** `GET /security` → `ui` (version, bundle SHA-256, log index, `lastUpdateCheck`) with an owner session from the target, and the served bundle over HTTP on the engine's origin.
- **Store layout:** the suite serves the layout the mock and X-03 use, adopted as the **release mirror layout v1** (decided 2026-10-26, proposed to the engine team for review before the E-02 freeze): `ui/latest.json` (`{ "version" }`, an unsigned hint), `release-log/ui-<version>.json` (`SignedRelease`), `release-log/revocations.json` (revocation DSSE envelope) and `ui/<version>/<artifact name>`, below `PTBK_UI_RELEASE_URL`.

### Decided alongside (2026-10-26, Seb)

- **A revoked current bundle stops being served immediately.** When an accepted, fresh revocation list names the active bundle's version, the engine falls back to the previously accepted bundle if that one is not revoked, and otherwise serves the plain engine page saying the UI is unavailable. `lastUpdateCheck` reports `refused` with reason `revoked` and the revoked version, unless the same check installs a newer release. The mock implements it (M-05 behaviour change).
- **`ui.lastUpdateCheck.eligibleAt`** (engine API 1.10.0, additive): set exactly when `reason` is `delay-not-elapsed`, so an owner sees when a delayed UI release installs and the suite can prove `firstSeenAt` survives a restart.

## Scope

- `packages/conformance/src/suites/ui-loader/` (portable: fetch and WebCrypto):
  - `sigstore/`: an ephemeral test Sigstore (CA, CT log, Rekor log keys; DER encoder) that writes a trusted root and DSSE bundles `@sigstore/verify` accepts.
  - `releases.ts`: test release keys, release entries, `SignedRelease` records, revocation lists, UI archives (deterministic ustar with raw-block zstd frames, plus deliberately unsafe archives), and Ed25519 signatures crafted per strict-verification case.
  - `store-layout.ts`: the mirror layout v1, in one place.
  - `lab.ts`: the `UiLoaderLab` port the checks use (start or restart the engine with settings, a fresh data directory or the same one; the fake store's contents and request log; the engine target); `bench.ts`: the helpers that publish a release, restart the engine and wait for its check.
  - `checks/*.ts` and `index.ts`: the checks, also run in-process against fake loaders by the package tests.
- `packages/conformance/node/suites/ui-loader/`: the platform suite on C-08's harness, registered in `PLATFORM_SUITES`: a lab per check (the fake store over HTTPS with a certificate from the harness CA on a `*.localhost` name, the trust file, the registered engine restarted with new settings), and an `EngineEndpoints` port for reaching the engine API through a relay. Until C-09's fake relay provides one for real runs, the checks skip with `engine-api-unreachable`; the package test supplies a test-only relay endpoint and runs every check against the mock engine.
- `packages/engine-api`: `UiUpdateCheck.eligibleAt`, `ENGINE_API_VERSION` 1.10.0, OpenAPI in sync.
- `apps/mock-engine`: `PTBK_CONFORMANCE_TRUST_FILE`, `eligibleAt`, and the revoked-current fallback.
- Docs: [ui-loader.md](../../engine-integration/ui-loader.md) (conformance build, mirror layout v1, revoked current bundle, `eligibleAt`), [conformance.md](../../engine-integration/conformance.md) (`ui-loader` row), [checklist.md](../../engine-integration/checklist.md) (every check ID), the conformance README.

### Checks

The five IDs C-05 registered keep their names; the rest are new. Every refusal check also asserts that the previous bundle is still served and that `lastUpdateCheck` names the refused version and reason.

| ID                                            | What it checks                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui-loader.install.pinned-valid`              | A valid regular release installs under `pinned`; the panel shows its version, archive SHA-256 and log index; its files are served                                                                                                                                                                                |
| `ui-loader.signature.strict-ed25519`          | Release-key signatures over the PAE built for each case class of C-01's `ed25519-vectors.json` get exactly the strict verdict (`verifyEd25519`): non-canonical R or A, negative-zero R, S ≥ L and a small-order A (a trust policy listing one) refused; small-order and mixed-order R and mixed-order A accepted |
| `ui-loader.signature.threshold`               | Release key alone (no or invalid provenance), provenance alone, provenance with an untrusted key and maintainers only are refused; a security release needs 2 distinct maintainer keys on top                                                                                                                    |
| `ui-loader.dsse.pae-only`                     | A signature over the raw payload, a changed payload byte and a wrong `payloadType` are refused                                                                                                                                                                                                                   |
| `ui-loader.entry.strict-payload`              | A validly signed payload with a duplicate key or an unknown field is refused                                                                                                                                                                                                                                     |
| `ui-loader.provenance.exact-identity`         | Wrong repository, repository ID, workflow path, tag, commit, runner, trigger or issuer, a SAN with an extra prefix or suffix, and an extension that is not a DER UTF8String are refused                                                                                                                          |
| `ui-loader.provenance.log-required`           | Provenance without a log entry, or from a CA outside the trusted root, is refused                                                                                                                                                                                                                                |
| `ui-loader.delay.trusted-time`                | Under `auto`, a backdated `publishedAt` does not shorten the delay: refused with `delay-not-elapsed` and `eligibleAt` at least 72 h after the trusted time                                                                                                                                                       |
| `ui-loader.delay.first-seen-persisted`        | `eligibleAt` is unchanged after a restart, so restarting cannot reset the delay                                                                                                                                                                                                                                  |
| `ui-loader.artifact.hash-mismatch`            | An archive that differs from the entry's SHA-256 is refused                                                                                                                                                                                                                                                      |
| `ui-loader.manifest.files-enforced`           | An unlisted file, a missing file, a file whose hash or size differs, and a manifest whose version or commit differs from the entry are refused                                                                                                                                                                   |
| `ui-loader.archive.unsafe-entries`            | Archives with `../`, an absolute path, a symlink or a hard link are refused                                                                                                                                                                                                                                      |
| `ui-loader.manifest.engine-api-range`         | A bundle whose `engineApi` range excludes the engine's API version is refused                                                                                                                                                                                                                                    |
| `ui-loader.rollback.not-newer`                | Pinning an older or the same version (with other bytes) does not replace the active bundle                                                                                                                                                                                                                       |
| `ui-loader.revocations.expired-keeps-current` | An expired revocation list keeps the current version (`revocations-unverifiable`, `expired`)                                                                                                                                                                                                                     |
| `ui-loader.revocations.unverifiable`          | A missing list, a list signed by an untrusted key, one issued too far in the future and one valid for too long keep the current version with the matching reason                                                                                                                                                 |
| `ui-loader.revocations.rollback-persisted`    | After a restart, a validly signed list older than the last accepted one is `rolled-back`                                                                                                                                                                                                                         |
| `ui-loader.revocations.revoked-refused`       | A release whose version is on the list is refused                                                                                                                                                                                                                                                                |
| `ui-loader.revocations.revoked-current`       | When the active version is revoked, it stops being served: the previous bundle comes back if it is not revoked, else the plain engine page                                                                                                                                                                       |
| `ui-loader.store.unavailable-keeps-current`   | A store that fails mid-check keeps the current bundle                                                                                                                                                                                                                                                            |
| `ui-loader.policy.honoured`                   | `pinned` installs exactly `PTBK_PINNED_VERSION` whatever `latest.json` says; `auto` checks `latest.json`; `manual` installs nothing at startup                                                                                                                                                                   |
| `ui-loader.serve.listed-files-only`           | Only manifest files are served; an unknown asset is 404; the SPA fallback answers HTML navigations but never shadows the engine's reserved paths                                                                                                                                                                 |
| `ui-loader.serve.security-headers`            | Every bundle response (entry, asset, fallback, 404) carries `ENGINE_UI_CSP` byte for byte and the engine's header set, also for a bundle whose manifest `csp` differs                                                                                                                                            |

## Out of scope

- The harness itself (C-08: `--engine-cmd`, `EngineProcess`, test CA trust). The relay suite and its fake relay (C-09), which also gives real runs their `EngineEndpoints`. Engine binary updates.
- Session bootstrap on the real engine (C-05's open point).

## Design notes

- Versions in one run increase monotonically (`1.0.<n>`), so checks share one engine without colliding; a check that needs a clean state asks for a fresh data directory.
- Waiting for a check: after a restart the suite polls `GET /security` until `lastUpdateCheck.at` is not older than the restart and the store saw the release record fetched; a timeout fails with the engine's log tail.
- Every check is proven able to fail: the package tests run each check against in-process fake engines built on `verifyRelease`, one per defect (skipped provenance, cofactorless or lenient Ed25519, raw-payload signatures, regex identity match, `publishedAt` delay, unpersisted `firstSeenAt` or revocation state, unchecked hashes, lenient unpacker, unlisted files served, missing headers, downgrade, revoked current bundle kept).

## Acceptance criteria

- [x] Every check above passes against the mock engine through the platform harness, as a package test (so in `bun run check` and CI).
- [x] Each check fails against at least one deliberately broken fake loader (package tests).
- [x] Minted Sigstore bundles verify with `@sigstore/verify` 4.1.2 and the reference verifier in `@ptbk/release-tools`; the negative knobs are refused.
- [x] Coverage ≥ 90% lines and branches for `packages/conformance` (signature and verification code included).
- [x] Mock: `PTBK_CONFORMANCE_TRUST_FILE` works and is refused under `NODE_ENV=production`; a revoked active bundle falls back or stops being served; `eligibleAt` is reported.
- [x] Every check ID appears in [checklist.md](../../engine-integration/checklist.md); [ui-loader.md](../../engine-integration/ui-loader.md) states the conformance build rules and the mirror layout v1.
- [x] Lint, typecheck and tests with coverage pass for the touched modules, and the CI platform step passes for `ui-loader` (fast check policy, 2026-10-26).
- [x] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The conformance build should announce itself in the contract (a `build: "conformance"` field in `GET /engine`); until a field exists, the startup log carries it. Recommendation: add it in the next additive engine API version.
- The mirror layout v1 is proposed, pending the engine team's review before the E-02 freeze.
