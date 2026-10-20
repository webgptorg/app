# Recorded Sigstore bundles

Real, public SLSA provenance bundles signed by GitHub Actions on Sigstore's public-good instance. They exercise the real `@sigstore/verify` path (Fulcio chain, SCT, Rekor entry, RFC 3161 timestamp) against `release/trusted_root.json` without network access. Their payloads are in-toto statements, not release entries: the adapter compares payloads byte for byte and does not care about the type.

| File                         | Source                                                                                                       | Why                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `hono-4.13.13.sigstore.json` | `https://slsa.dev/provenance/v1` bundle from `https://registry.npmjs.org/-/npm/v1/attestations/hono@4.13.13` | Tag push (`refs/tags/v4.13.13`, trigger `push`): matches `expectedWorkflowClaims` as is; Rekor entry only |
| `vite-8.3.4.sigstore.json`   | `https://slsa.dev/provenance/v1` bundle from `https://registry.npmjs.org/-/npm/v1/attestations/vite@8.3.4`   | Has both an RFC 3161 TSA timestamp and a Rekor integrated time                                            |

Both were saved unchanged (pretty-printed JSON of the `bundle` field). If `release/trusted_root.json` is refreshed and a key they depend on is dropped, record new bundles the same way.
