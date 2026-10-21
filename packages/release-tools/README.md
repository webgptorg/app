# @ptbk/release-tools

Node-only tooling for UI releases, shared by the release scripts in `apps/engine-ui/scripts` (X-03), which build, pack and verify a release, and by the mock engine's UI loader (M-05), which downloads, verifies and serves one. Apps never import each other, so the code both sides run lives here, once.

- `createSigstoreProvenanceVerifier(trustedRoot)`: C-06's `ProvenanceVerifier` on `@sigstore/verify` 4.1.2 directly (never `sigstore.verify()`, whose identity match is an unanchored pattern and whose OID comparison uses raw DER; lint and `package-boundary.test.ts` keep `sigstore` out). `tlogThreshold: 1`, `ctlogThreshold: 1`, the exact SAN as the certificate's single URI, every required Fulcio extension DER-decoded as a UTF8String and compared exactly, `trustedTime` the latest verified timestamp (RFC 3161, or Rekor integrated time backed by a signed entry timestamp).
- `PINNED_TRUSTED_ROOT` (`src/trusted_root.json`): Sigstore's public-good trusted root, copied byte for byte from TUF and refreshed only in a reviewed PR (`bun run --filter @ptbk/engine-ui release:refresh-trusted-root`). `checkTrustedRoot` validates one.
- `writeTar`, `readTar`, `readTree`: the bundle's deterministic ustar codec. The reader refuses links, devices, extended headers, unsafe or duplicate paths and anything beyond `TAR_LIMITS` (10,000 entries, 200 MB).
- `readUiArchive`: a `tar.zst` UI archive, manifest first, within those limits; a zstd bomb stops at the cap.

Recorded Sigstore fixtures and where they come from: [src/fixtures/README.md](src/fixtures/README.md).

MIT and dependent only on `@ptbk/protocol` and the pinned `@sigstore/*` packages, so it can move public with the contracts if the engine team wants the reference verifier as code (ADR 0002); whether it does is decided at E-02.
