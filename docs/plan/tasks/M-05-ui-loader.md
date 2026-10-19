# M-05. UI loader in the mock engine (reference implementation)

- **Lane:** Mock engine · **Module:** `apps/mock-engine` · **Milestone:** M2
- **Depends on:** C-06, X-03, M-02, M-04 · **Unblocks:** X-04
- **Status:** todo
- **Spec:** Architecture (UI delivery); Interfaces (draft) 5 and 6; Engine security baseline (Browser headers); Security hardening (1, 5); ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md), [0004](../../adr/0004-mock-engine-and-conformance.md)

## Goal

The mock engine downloads the signed engine-ui bundle, verifies it like a release, keeps the previous bundle when anything fails, and serves it from its own origin under the engine's strict security headers. It is the reference the engine team ports to the real engine (about 100 lines of core logic there).

## Context

ADR 0003: we never serve UI to browsers. X-03 builds, signs and publishes the bundle with a manifest; C-06 provides release-log types and verification. This task is where both meet a running engine, and where engine-ui first runs under the real CSP. The security headers are engine code, not part of the bundle, so the bundle can never loosen them.

## Scope

- Ports in `src/domain/ui/`: `ReleaseSource { latest(signal); entry(version, signal); revocations(signal); artifact(name, signal): Promise<ReadableStream<Uint8Array>> }` and `BundleStore { active(): InstalledBundle | undefined; stage(...); activate(id); previous(): InstalledBundle | undefined }`. In-memory adapters for both.
- `src/domain/ui/ui-update.ts`: `checkForUiUpdate(deps): Promise<UiUpdateOutcome>` with `UiUpdateOutcome = { kind: 'up-to-date' } | { kind: 'installed'; version; sha256 } | { kind: 'refused'; reason: 'signature' | 'log-inclusion' | 'delay' | 'revoked' | 'hash-mismatch' | 'manifest' | 'unpack' } | { kind: 'unavailable' }`. Verification uses C-06's functions only (threshold, log inclusion, delay against the injected `Clock`, revocation); the artifact with `"kind": "ui"` is hashed while streaming and compared with the entry; files are checked against X-03's manifest.
- `src/adapters/ui/http-release-source.ts`: `fetch` against `PTBK_UI_RELEASE_URL` (a local file server in tests, MinIO or a static server in e2e), timeouts and size caps on every request.
- `src/adapters/ui/bundle-unpacker.ts`: `tar.zst` via Node 24's `zlib` zstd decompressor and a minimal ustar reader (or `tar` 7.x if a dependency is justified). Rejects absolute paths, `..`, symlinks, hard links, devices, duplicate paths, more than 10,000 files or more than 200 MB unpacked.
- `src/adapters/ui/fs-bundle-store.ts`: unpacks into `PTBK_DATA_DIR/ui/staging-<random>/`, verifies, renames to `ui/<version>-<sha256 prefix>/`, makes it read-only, and switches `ui/active.json` atomically (write temp, rename). Keeps the previous bundle; deletes older ones and failed staging dirs.
- `src/domain/http/security-headers.ts`: one function returning the engine's headers, applied by a Hono middleware to every in-tunnel response (UI, API, sign-in, errors): `Content-Security-Policy` set to `ENGINE_UI_CSP` imported from `@ptbk/engine-api` (C-04; the one string the bundle, the mock engine, conformance and the real engine share; never a local copy), `Strict-Transport-Security: max-age=31536000`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a `Permissions-Policy` that disables camera, microphone, geolocation, payment and USB.
- `src/domain/ui/static-route.ts`: pure `resolveStatic(path, method, accept, manifest)` returning `{ kind: 'asset'; file; cache: 'immutable' | 'no-cache' } | { kind: 'spa-fallback' } | { kind: 'not-found' }`. Hashed assets get `Cache-Control: public, max-age=31536000, immutable`; `index.html` and unhashed files get `no-cache`. SPA fallback only for `GET`/`HEAD` with `Accept` containing `text/html`, outside the API base path, `/assets/` and `/__spike/`. Only files listed in the manifest are served; correct `Content-Type` from a fixed extension map.
- `src/adapters/http/ui-routes.ts`: serves the active bundle behind the gateway session (anonymous visitors get only the sign-in page: open code). If no bundle has ever installed, answers 503 with a plain engine page.
- Update triggers: at startup and every `MOCK_UI_CHECK_INTERVAL_S` (default 3600); also `POST /__mock/ui/check` on the control server when M-04's control server exists. Exposes the active bundle version, SHA-256 and log entry for the security panel endpoint.
- Config: `PTBK_UI_RELEASE_URL`, `PTBK_UPDATE_POLICY` (`auto` | `manual` | `pinned`), `PTBK_PINNED_VERSION`, `MOCK_UI_TRUSTED_KEYS_FILE` (release public keys for C-06), `MOCK_UI_CHECK_INTERVAL_S`.

## Out of scope

- Building, signing and publishing the bundle (X-03). Engine binary updates. The UI flows themselves (X-04). Staged-rollout randomisation (engine updater).

## Design notes

- Fail closed and keep serving: any refusal or error leaves the active bundle untouched and logs `ui.refused` with the reason and version, never file contents.
- Delay: `auto` enforces C-06's delay with the injected clock; `manual` and `pinned` may install before the delay ends (spec, Updates), still requiring signatures, log inclusion and no revocation. E2E uses `pinned`.

## Acceptance criteria

- [ ] `ui-update` tests with in-memory adapters and fixture releases signed at test time: valid install; each refusal reason (bad signature, below threshold, no inclusion proof, delay not passed under `auto`, revoked, artifact hash mismatch, manifest mismatch); network failure mid-download yields `unavailable`; in every failure case the previous bundle stays active.
- [ ] Unpacker tests: path traversal, absolute path, symlink, hard link, oversize and too many files are rejected; staging dirs are cleaned up.
- [ ] `static-route` tests: hashed asset immutable, `index.html` no-cache, `/agents/123` with `Accept: text/html` falls back, `/assets/missing.js` is 404, `POST` to an unknown path is 404, API paths never fall back.
- [ ] Every in-tunnel response, including 404, 401 and 503, carries the full header set (snapshot test of the header map).
- [ ] E2E smoke: the mock engine installs X-03's test-signed bundle from the local store, a signed-in Playwright session loads the UI through the relay with zero CSP or Trusted Types violations reported, and a tampered bundle published next is refused while the old one keeps loading.
- [ ] `bun run check` and the e2e suite pass.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The allowed Trusted Types policy names (`ptbk-html`) are part of `ENGINE_UI_CSP` and therefore engine-defined, never read from the bundle.
- Whether `Cross-Origin-Embedder-Policy: require-corp` should be added is open; leave it out until the UI is tested with it.
