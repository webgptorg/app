# C-06. Release log entry and verification (engine and UI artifacts)

- **Lane:** Contracts · **Module:** `packages/protocol` · **Milestone:** M2
- **Depends on:** C-01
- **Status:** todo
- **Spec:** Interfaces (draft) 5. Release log entry, Residual risks: certificates and engine updates (2. Engine updates, Release keys), Transparency and verifiability, Security hardening 9 and 10; ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md)

## Goal

`@ptbk/protocol` exports the release log entry and revocation schemas, the UI bundle manifest schema, the canonical signing payload, and one pure `verifyRelease` function that decides whether an engine may install or serve a release.

## Context

Updates are the main remaining path to customer data, so this check is the core of the update and UI-loader trust story. The same function is used by the mock engine's UI loader (M-05, reference implementation for the engine team), by the UI bundle pipeline to self-check what it publishes (X-03), and later by the real engine's updater and loader. It must be pure and deterministic: time, the transparency log and keys are inputs.

## Scope

- `src/release/entry.ts`: `ReleaseEntry { v: 1, version: EngineVersion, gitTag, commit (40 hex), artifacts: Artifact[] (1–32, unique names), kind: 'regular' | 'security', advisory: url | null, publishedAt: Timestamp, provenance: string (the Sigstore bundle of the release workflow's keyless signature over the signing payload, as JSON text, ≤ 64 KiB), signatures: ReleaseSignature[] }`, `Artifact { name, sha256 (64 hex), kind: 'engine' | 'ui' }`, `ReleaseSignature { keyId, sig: Ed25519Signature }`, `RevocationEntry { v: 1, revokes: EngineVersion, reason (≤ 500 chars), signatures }`. Refinements: `security` requires a non-null `advisory`; at most one `ui` artifact.
- `src/release/manifest.ts`: `UiBundleManifest { v: 1, version: EngineVersion, commit (40 hex), engineApi (SemVer range of the `ENGINE_API_VERSION`values the bundle supports, e.g.`>=1.0.0 <2.0.0`), entry: 'index.html', files: [{ path, sha256 (64 hex), size (bytes, safe integer ≥ 0) }], csp: string }`. `csp` records the `ENGINE_UI_CSP` the bundle was tested against and is informational only: the loader never reads it, because the engine's headers are engine code. Because `protocol` cannot import `engine-api`, `engineApi` is validated here only as a range string (a small range grammar: `>=`, `<`, `^` on full versions); the loader checks it against `ENGINE_API_VERSION`. Paths are safe relative paths (1–1,024 chars, no `..` or empty segment, no leading `/`, no backslash, no duplicates). Per the spec the `ui` artifact's SHA-256 pins the tarball; the manifest inside it lets the loader re-check every unpacked file, so an unpacker bug cannot serve a file the release did not contain.
- `src/release/canonical.ts`: `releaseSigningPayload(entry)` and `revocationSigningPayload(entry)`: `signingInput('ptbk-release-v1' | 'ptbk-revocation-v1', sha256Base64Url(JCS(entry without signatures and provenance)))`, JCS per RFC 8785. `provenance` is excluded because it is itself a signature over this payload; revocations have no `provenance`.
- `src/clock.ts`: `Clock` port (`now(): Date`) and `createFixedClock(date)` for tests, if no earlier task added it.
- `src/release/trust.ts`: `TrustPolicy { releaseKeys: KeyRef[], maintainerKeys: KeyRef[] (3), securityThreshold: 2, workflowIdentity: { issuer, subjectPattern }, revocationRule, delays: { regularMs: 72 h, securityMs: 24 h } }`, `KeyRef { keyId, publicKey }`.
- `src/release/transparency-log.ts`: `TransparencyLog` port: `verifyInclusion(payload: Bytes, proof: unknown, signal): Promise<{ kind: 'included', logIndex, integratedAt: Date | null } | { kind: 'not-included', reason }>`; plus `createFakeTransparencyLog()` for tests and local development.
- `src/release/provenance.ts`: `ProvenanceVerifier` port: `verifyProvenance(bundle: string, payload: Bytes, identity: TrustPolicy['workflowIdentity'], signal): Promise<{ kind: 'verified' } | { kind: 'invalid', reason }>`; plus `createFakeProvenanceVerifier()` that accepts a fixed test provenance string (tests and e2e only).
- `src/release/verify.ts`: `verifyRelease(input, deps)` (below), and `verifyArtifact(artifact, bytes)` / `verifyManifestFiles(manifest, files)` for hash checks.

## Out of scope

- The real Sigstore adapter (sigstore npm 5.x is Node-only): it lives where it is used, `apps/mock-engine/src/adapters/` in M-05 and the engine's own code. Signing, building and publishing to R2 (X-03, I-03). Downloading and unpacking (M-05).

## Design notes

- **Protocol design:** follows [ADR 0010](../../adr/0010-protocol-design-principles.md).
- `verifyRelease({ entry, proof, revocations, policy, mode: 'auto' | 'manual', installedVersion | null }, { log: TransparencyLog, provenance: ProvenanceVerifier, clock: Clock })` checks in this order and returns the first failure: `invalid-entry`, `signature-threshold-not-met`, `not-in-log`, `revoked`, `not-newer` (version ≤ installed; the updater's downgrade refusal), `delay-not-elapsed { eligibleAt }`; otherwise `{ kind: 'ok', eligibleAt }`. `mode: 'manual'` skips only the delay (spec: manual approval may install early); no mode skips signatures, log or revocation.
- Threshold (decided 2026-10-19): `regular` needs **both** a keyless Sigstore signature whose certificate identity is the release workflow (this repo, the release workflow file, the tagged commit; `entry.provenance` checked through the `ProvenanceVerifier` port against `policy.workflowIdentity`) **and** a valid signature from a release key held by a human on a hardware key, so a compromised CI alone cannot ship. `security` additionally needs valid signatures from 2 distinct maintainer keys, as the spec says. Signatures from unknown key IDs are ignored, duplicates count once, a malformed signature never throws.
- Delay starts at the later of `publishedAt` and the log's `integratedAt` (when known), so a backdated `publishedAt` cannot shorten it.
- Revocations count only if they verify under `policy.revocationRule` and match `entry.version`; invalid revocations are ignored and reported.
- Artifact hashes compared with `bytesEqual` on decoded digests, after streaming SHA-256 over the bytes; a mismatch is `{ kind: 'hash-mismatch', name }`.

## Acceptance criteria

- [ ] One test per outcome, plus: regular release with a valid release-key signature but invalid or missing provenance fails, and valid provenance without a release-key signature fails; security release with 1 valid and 1 invalid maintainer signature fails; same maintainer twice fails; regular release signed only by maintainers fails (unless policy says otherwise); revocation for another version is ignored; revocation with a bad signature is ignored; delay boundary at exactly `eligibleAt` passes and 1 ms before fails; backdated `publishedAt` uses `integratedAt`.
- [ ] Canonical payload: reordering JSON keys or whitespace gives the same payload; changing any field except `signatures` and `provenance` changes it. Golden vectors (entry, payload hex, signatures with fixed test keys) checked in.
- [ ] Manifest: unknown field, missing `commit`, malformed `engineApi` and negative `size` are rejected. Path tests: `../x`, `/x`, `a\b`, `a//b`, empty, duplicate, and a 1,025-char path are rejected.
- [ ] Property test: arbitrary JSON never makes `ReleaseEntry` parsing or `verifyRelease` throw.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Revocation threshold is not in the spec. Default proposal: release key or any one maintainer (stopping a release is the safe direction), configurable in `TrustPolicy`.
- What exactly Rekor logs (the signing payload as a hashedrekord, or a DSSE envelope of the entry) and Rekor v2's lack of integrated timestamps affect the port's `integratedAt`; settle in M-05 with the real adapter.
- Staged rollout (random install moment within 24 h after the delay) is the updater's job, not this function's.
