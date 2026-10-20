# X-03. UI bundle build, manifest, signing and publishing

- **Lane:** X · **Module:** `apps/engine-ui` (release scripts) and `.github/workflows/ui-release.yml` · **Milestone:** M2
- **Depends on:** U-01, C-06
- **Status:** in progress (feat/x-03-ui-bundle-release)
- **Spec:** Architecture (UI delivery), Interfaces (5 release log entry), Transparency and verifiability (2), Residual risks (2 engine updates, release keys), Security hardening (10); ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md), [0014](../../adr/0014-cryptography.md)

## Goal

A tagged commit produces a reproducible `engine-ui.tar.zst` with a manifest, signed with Sigstore, logged in Rekor, described by a release log entry (C-06) and published to R2, so the engine's loader (M-05) can fetch and verify it.

## Context

The UI runs with full access to decrypted engine data, so its release path is the real protection against a malicious UI (ADR 0003). The loader checks signature threshold, Rekor inclusion, delay and revocation, then compares every file with the manifest. Reproducibility lets us, or an auditor under NDA, prove the bundle matches the source. A regular release needs both the CI keyless workflow signature (Sigstore provenance) and the human-held release key (hardware key); a `security` release needs both of those and additionally 2 of 3 maintainer keys (provenance + release key + 2 maintainers). The key ceremony and the key holders are the human decision in the plan's "Still needed" table, so production signing waits on it; staging pairs the keyless signature with a staging release key now, so C-06's `verifyRelease` exercises the same two-signature rule.

## Scope

- `apps/engine-ui/scripts/` (run with Node 24; new dependencies, all pinned exactly in the workspace catalog: `sigstore@5.0.0` for signing, plus `@sigstore/verify@4.1.2`, `@sigstore/bundle@5.0.0` and `@sigstore/protobuf-specs@0.5.2` for `release:verify`):
  - `pack.ts`: builds with `SOURCE_DATE_EPOCH` set to the commit time, then writes `manifest.json` and a deterministic tar compressed with Node's built-in `zlib` zstd at a fixed level. Output in `apps/engine-ui/release/`.
  - `tar.ts`: minimal ustar writer: entries sorted by path, `manifest.json` first, mtime = `SOURCE_DATE_EPOCH`, uid/gid 0, empty user and group names, mode 0644 for files and 0755 for directories, no extended headers. Refuses symlinks, absolute paths, `..`, and paths over 100 bytes unless split into prefix/name.
  - `manifest.ts`: builds the manifest and validates it with C-06's `UiBundleManifest` schema.
  - `verify-reproducible.ts`: builds twice in two fresh copies of the repo at different paths, with different `TZ`, locale and umask, and compares SHA-256 of both archives; on mismatch prints the first differing file.
- Manifest: exactly C-06's `UiBundleManifest`, no extra fields: `v` (1), `version` (semver, equals `apps/engine-ui/package.json`), `commit`, `engineApi` (semver range of supported `ENGINE_API_VERSION`, the constant C-04 exports, e.g. `>=1.0.0 <2.0.0`), `entry` (`index.html`), `files` (sorted list of `{ path, sha256, size }`, every file in `dist/` and nothing else), `csp` (the `ENGINE_UI_CSP` string the bundle was tested against; informational only, the loader never uses it).
- The built bundle embeds its version through a Vite `define` (no timestamps, no commit time in code).
- `.github/workflows/ui-release.yml`, triggered by tags `ui-v*` and `workflow_dispatch`:
  1. `build` job: checks the tag matches the package version, runs `check`, `test:csp`, `pack` and `verify-reproducible`, uploads the archive and manifest as a workflow artifact.
  2. `sign` job (`permissions: id-token: write, contents: read`): signs the archive keylessly with `sigstore.sign()` (GitHub OIDC identity of this workflow), which records it in Rekor, and writes `engine-ui.tar.zst.sigstore.json`. It then writes C-06's `ReleaseEntry` payload (artifact `engine-ui.tar.zst`, `kind: "ui"`, sha256, version, commit, `gitTag`, `publishedAt`) as exact bytes once, and attests them with `sigstore.attest(payload, RELEASE_PAYLOAD_TYPE, { tsaServerURL })`, which produces a DSSE envelope logged as a Rekor `dsse` entry with an RFC 3161 TSA timestamp (the trusted time C-06's delay needs); that bundle becomes `SignedRelease.provenance`. The payload bytes are never re-serialised after this step.
  3. `publish` job in the `staging` GitHub environment (required reviewer): signs the DSSE PAE of the same payload with the staging release key (an environment secret only this environment can read) and writes the `SignedRelease` (envelope with that signature, `keyid` = C-06's `dsseKeyId`, plus `provenance`), runs `release:verify` against the staging `TrustPolicy` (staging release key plus this workflow's `workflowIdentity`), then uploads `ui/<version>/engine-ui.tar.zst`, `manifest.json`, `engine-ui.tar.zst.sigstore.json` and `release-log/ui-<version>.json` to the staging R2 bucket through the S3 API with `curl --aws-sigv4`, after checking that the version does not exist yet (never overwrite).
- Workflow rules: GitHub-hosted runners, SHA-pinned actions, default `contents: read`, `persist-credentials: false`, no caches, untrusted values through `env`; zizmor passes.
- Verification command `bun run --filter @ptbk/engine-ui release:verify <dir>` that runs C-06's `verifyRelease` with the real Sigstore adapter (C-06's `@sigstore/verify`-based adapter, not `sigstore.verify()`) against a downloaded release (release-key signature, provenance, Rekor inclusion, trusted time, manifest hashes); used by M-05's tests and by humans. Identity is exact: the adapter passes C-06's `expectedWorkflowClaims` (issuer, exact SAN `https://github.com/<repository>/.github/workflows/ui-release.yml@refs/tags/<gitTag>`, commit, ref, repository ID, `github-hosted` runner) and `tlogThreshold: 1` / `ctlogThreshold: 1`; the SAN and each decoded Fulcio extension are compared as exact strings, never through an identity regex, and `trustedTime` is the latest verified timestamp.
- `apps/engine-ui/release/trusted_root.json`: a pinned Sigstore trusted root (Fulcio, Rekor, TSA keys) committed to the repo and shipped with every release, so verification needs no live TUF fetch; a script refreshes it from Sigstore's TUF repository in a reviewed PR.

## Out of scope

- Production signing with the human-held release key, the key ceremony and the 2-of-3 maintainer signatures for `security` releases (I-03, after the plan's "Still needed" table names the key holders).
- Merging the UI artifact into the engine's release entry in the public repo (engine team, E-01).
- The loader that consumes the bundle (M-05). Rebuild monitor.

## Design notes

- Determinism sources to pin: Node version (`.nvmrc`), Bun lockfile, `SOURCE_DATE_EPOCH`, sorted tar entries, fixed zstd level, Vite's content hashing, no sourcemaps. Locale-dependent sorting is a classic bug: compare paths as bytes.
- The manifest lists files; the loader must serve only listed files with their hashes checked, so the manifest is the security boundary, not the archive layout.
- Signing an artifact and logging it are one step in sigstore-js; keep the Sigstore bundle next to the artifact so verification works offline against the pinned `trusted_root.json`.
- The release payload is signed as bytes, never as re-serialised JSON: the `sign` job writes the payload file once and every later step (attest, release-key signature, verify, upload) reads that file.

## Acceptance criteria

- [ ] Unit tests: the tar writer produces byte-identical output for the same input in a different order and readable output for `tar -tvf`; it rejects symlinks and `..`; the manifest builder lists exactly the `dist/` files with correct hashes and rejects a schema-invalid manifest.
- [ ] `verify-reproducible` passes locally and in the `build` job; a deliberately injected `Date.now()` in the build makes it fail (verified once, noted in the PR).
- [ ] A `workflow_dispatch` dry run (upload skipped) produces a signed archive and a `SignedRelease` with `provenance` (including a TSA timestamp) and a staging release-key signature that `release:verify` (C-06's `verifyRelease`, staging trust policy) accepts; an entry missing either signature is refused; tampering one byte of the archive, the payload or one manifest hash makes it fail; a trust policy with another `repository` or `workflowPath` makes it fail.
- [ ] Publishing an existing version fails without overwriting.
- [ ] [development.md](../../development.md) documents how to cut a UI release and verify one.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- A keyless signature proves "built by this workflow", not "approved by a human"; that is why a regular production release also needs the human-held release key (and a `security` release 2 of 3 maintainer keys). Key ceremony and holders are open in the plan's "Still needed" table. The staging release key must never appear in a production trust policy.
- Hardware release key: Ed25519 PureEdDSA over arbitrary bytes (the PAE) needs e.g. a YubiKey 5.7+ PIV slot via PKCS#11; many tokens only do Ed25519 for SSH or OpenPGP. Rehearse the ceremony (sign a staging PAE with the real token, verify with C-06) before the E-02 freeze.
- The spec puts the UI artifact into the same release entry as the engine. Until the engine release tooling exists, UI releases get their own entry; agree with the engine team how the engine release references the UI artifact (version and sha256).
- Version scheme: the spec wants engine and UI versions to match; confirm whether `ui-v<version>` tags follow engine versions or the UI has its own semver with the `engineApi` range doing compatibility.
- `workflow_dispatch` is allowed as a trigger, so a release could come from a manual run on a tag. Open: also pin Fulcio OID `1.3.6.1.4.1.57264.1.20` (build trigger, e.g. `push`) in C-06's `expectedWorkflowClaims` for production, which would make dispatched runs dry runs only.
- e2e (X-04) cannot use GitHub OIDC on pull requests; M-05 needs a test trust root (an ephemeral key generated per run) that exercises the same verification code.
