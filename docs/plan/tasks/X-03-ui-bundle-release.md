# X-03. UI bundle build, manifest, signing and publishing

- **Lane:** X · **Module:** `apps/engine-ui` (release scripts) and `.github/workflows/ui-release.yml` · **Milestone:** M2
- **Depends on:** U-01, C-06 · **Unblocks:** M-05, I-03
- **Status:** todo
- **Spec:** Architecture (UI delivery), Interfaces (5 release log entry), Transparency and verifiability (2), Residual risks (2 engine updates, release keys), Security hardening (10); ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md)

## Goal

A tagged commit produces a reproducible `engine-ui.tar.zst` with a manifest, signed with Sigstore, logged in Rekor, described by a release log entry (C-06) and published to R2, so the engine's loader (M-05) can fetch and verify it.

## Context

The UI runs with full access to decrypted engine data, so its release path is the real protection against a malicious UI (ADR 0003). The loader checks signature threshold, Rekor inclusion, delay and revocation, then compares every file with the manifest. Reproducibility lets us, or an auditor under NDA, prove the bundle matches the source. Production signing (2 of 3 release key holders) waits on the key-holder decision; staging uses keyless signing now.

## Scope

- `apps/engine-ui/scripts/` (run with Node 24, no new dependencies):
  - `pack.ts`: builds with `SOURCE_DATE_EPOCH` set to the commit time, then writes `manifest.json` and a deterministic tar compressed with Node's built-in `zlib` zstd at a fixed level. Output in `apps/engine-ui/release/`.
  - `tar.ts`: minimal ustar writer: entries sorted by path, `manifest.json` first, mtime = `SOURCE_DATE_EPOCH`, uid/gid 0, empty user and group names, mode 0644 for files and 0755 for directories, no extended headers. Refuses symlinks, absolute paths, `..`, and paths over 100 bytes unless split into prefix/name.
  - `manifest.ts`: builds the manifest and validates it with the schema from C-06.
  - `verify-reproducible.ts`: builds twice in two fresh copies of the repo at different paths, with different `TZ`, locale and umask, and compares SHA-256 of both archives; on mismatch prints the first differing file.
- Manifest (`v: 1`, `kind: "ui"`): `version` (semver, equals `apps/engine-ui/package.json`), `commit`, `engineApi` (semver range of compatible engine API versions, e.g. `>=1.0.0 <2.0.0`, from the `ENGINE_API_VERSION` C-04 exports), `entry` (`index.html`), `files` (sorted list of `{ path, sha256, size }`, every file in `dist/` and nothing else), `csp` (the `ENGINE_UI_CSP` string the bundle was tested against).
- The built bundle embeds its version through a Vite `define` (no timestamps, no commit time in code).
- `.github/workflows/ui-release.yml`, triggered by tags `ui-v*` and `workflow_dispatch`:
  1. `build` job: checks the tag matches the package version, runs `check`, `test:csp`, `pack` and `verify-reproducible`, uploads the archive and manifest as a workflow artifact.
  2. `sign` job (`permissions: id-token: write, contents: read`): signs the archive keylessly with the `sigstore` npm package (GitHub OIDC identity of this workflow), which records it in Rekor, writes `engine-ui.tar.zst.sigstore.json`, and creates the release log entry from C-06 (artifact `engine-ui.tar.zst`, `kind: "ui"`, sha256, version, commit, `publishedAt`), signed the same way.
  3. `publish` job in the `staging` GitHub environment (required reviewer): uploads `ui/<version>/engine-ui.tar.zst`, `manifest.json`, `engine-ui.tar.zst.sigstore.json` and `release-log/ui-<version>.json` to the staging R2 bucket through the S3 API with `curl --aws-sigv4`, after checking that the version does not exist yet (never overwrite).
- Workflow rules: GitHub-hosted runners, SHA-pinned actions, default `contents: read`, `persist-credentials: false`, no caches, untrusted values through `env`; zizmor passes.
- Verification command `bun run --filter @ptbk/engine-ui release:verify <dir>` that runs C-06's verifier against a downloaded release (signature, Rekor inclusion, manifest hashes); used by M-05's tests and by humans.

## Out of scope

- Production release keys, key ceremony and 2-of-3 signing (I-03, after the key holders are named).
- Merging the UI artifact into the engine's release entry in the public repo (engine team, E-01).
- The loader that consumes the bundle (M-05). Rebuild monitor.

## Design notes

- Determinism sources to pin: Node version (`.nvmrc`), Bun lockfile, `SOURCE_DATE_EPOCH`, sorted tar entries, fixed zstd level, Vite's content hashing, no sourcemaps. Locale-dependent sorting is a classic bug: compare paths as bytes.
- The manifest lists files; the loader must serve only listed files with their hashes checked, so the manifest is the security boundary, not the archive layout.
- Signing an artifact and logging it are one step in sigstore-js; keep the Sigstore bundle next to the artifact so verification works offline against a pinned trust root.

## Acceptance criteria

- [ ] Unit tests: the tar writer produces byte-identical output for the same input in a different order and readable output for `tar -tvf`; it rejects symlinks and `..`; the manifest builder lists exactly the `dist/` files with correct hashes and rejects a schema-invalid manifest.
- [ ] `verify-reproducible` passes locally and in the `build` job; a deliberately injected `Date.now()` in the build makes it fail (verified once, noted in the PR).
- [ ] A `workflow_dispatch` dry run (publish skipped) produces a signed archive and release log entry that `release:verify` accepts; tampering one byte of the archive or one manifest hash makes it fail.
- [ ] Publishing an existing version fails without overwriting.
- [ ] [development.md](../../development.md) documents how to cut a UI release and verify one.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Keyless staging signatures prove "built by this workflow", not "approved by two humans". Production needs the 2-of-3 release keys (plan, "Decisions needed from humans").
- The spec puts the UI artifact into the same release entry as the engine. Until the engine release tooling exists, UI releases get their own entry; agree with the engine team how the engine release references the UI artifact (version and sha256).
- Version scheme: the spec wants engine and UI versions to match; confirm whether `ui-v<version>` tags follow engine versions or the UI has its own semver with the `engineApi` range doing compatibility.
- e2e (X-04) cannot use GitHub OIDC on pull requests; M-05 needs a test trust root (an ephemeral key generated per run) that exercises the same verification code.
