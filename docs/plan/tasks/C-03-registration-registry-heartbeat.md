# C-03. Registration, registry lookup and heartbeat contracts

- **Lane:** Contracts · **Module:** `packages/protocol` · **Milestone:** M1
- **Depends on:** C-01
- **Status:** todo
- **Spec:** Interfaces (draft) 1, 2 and 4, What our platform can and cannot do (Heartbeat), Pairing and identity (First setup); ADRs: [0002](../../adr/0002-public-private-split.md)

## Goal

`@ptbk/protocol` exports strict schemas and pure helpers for engine registration, the relay's registry lookup and the signed heartbeat, including the verification the dashboard runs on every heartbeat.

## Context

These are the only messages between an engine and our dashboard, so the heartbeat schema is the public promise of what we learn about an engine: numbers only, no names or free text. The dashboard (D-03, D-04, D-05), the relay's HTTP registry adapter (D-04) and the mock engine (M-06) all build on these. Heartbeat verification must work on raw bytes, because the signature covers the body exactly as sent.

## Scope

- `src/registration.ts`: `RegisterEngineRequest { linkCode, enginePublicKey: Ed25519PublicKey, engineVersion: EngineVersion, mode: 'tunnel' | 'direct', sig: Ed25519Signature }` (local engines never register, so there is no `local` mode here) where `sig` covers `signingInput('ptbk-register-v1', linkCode, enginePublicKey, engineVersion)` (proof of key possession: nobody can register someone else's key with a stolen link code); `signRegistration(signer, request)` and `verifyRegistration(request)`, `RegisterEngineResponse { engineId, hostname, relays: Hostname[] (1–16, unique) }`, path constant `REGISTER_PATH = '/v1/engines/register'`, and `checkRegistrationResponse(response, publicKey, engineDomain)` returning `{ kind: 'ok' } | { kind: 'engine-id-mismatch' } | { kind: 'hostname-mismatch' }` so the engine refuses a dashboard that hands it someone else's identity.
- `src/link-code.ts`: `LinkCode` branded schema: 128 random bits as lowercase RFC 4648 base32 without padding, so exactly 26 characters of `[a-z2-7]` whose last character carries zero trailing bits (canonical, one accepted spelling per code). No grouping or separators: the code is copied, not typed. `generateLinkCode(randomBytes)` takes the random source as an input so it stays testable; D-03 hashes and stores it.
- `src/registry.ts`: `RegistryEntry { enginePublicKey, hostnames: Hostname[], claims: HostnameClaim[], status: 'active' | 'suspended' }`, `HostnameClaim { hostname, sig }`, path builder `registryPath(engineId)` = `/internal/v1/engines/{engineId}`, and `resolveRoutableHostnames(engineId, entry, engineDomain)`: returns the default hostname plus every custom hostname whose claim verifies; drops the rest and reports them (`{ hostnames, dropped: Hostname[] }`). This is the single claim-verification implementation: the relay (R-02, R-03) calls it on every registry read and the dashboard (D-04) calls it before storing or serving claims; neither reimplements it.
- `src/heartbeat.ts`: `Heartbeat` schema per spec (`v: 1, engineId, seq, ts, version, uptimeS, diskPct, ramPct, cpuLoad, update, agents, members`); `HEARTBEAT_SIGNATURE_HEADER = 'Ptbk-Signature'`; `parseSignatureHeader('ed25519=<b64url>')`; `buildHeartbeat(input)` that rounds percentages to tens and returns the exact bytes to send; `signHeartbeat(signer, bodyBytes)`, signing `signingInput('ptbk-heartbeat-v1', sha256Base64Url(bodyBytes))` (decided 2026-10-19 per ADR 0010; the header still carries the exact body bytes' signature in `Ptbk-Signature: ed25519=<b64url>`); `verifyHeartbeat(...)` (below).
- `src/problem.ts`: RFC 9457 `ProblemDetails` schema (`type, title, status, detail?, code`) used for dashboard API errors (same shape as C-04, defined here separately because `engine-api` cannot import `protocol`), and `REGISTRATION_ERROR_CODE`: `invalid-link-code` (one code for a bad, expired or used link code, so the dashboard is no oracle), `engine-exists`, `engine-suspended`, `engine-limit`, `bad-signature`.

## Out of scope

- Dashboard endpoints, storage, link-code hashing (D-03), relay authentication to the registry (D-04), Durable Object state (D-05), the engine-side client (M-06).

## Design notes

- Decided 2026-10-19 (spec updated): registration is signed by the engine key; the registry entry carries `claims: [{ hostname, sig }]`. The relay looks engines up by engine ID at tunnel auth and keeps a hostname → engine map only for engines connected to it (refreshed every 5 minutes), so no lookup by hostname is needed.
- **Protocol design:** follows [ADR 0010](../../adr/0010-protocol-design-principles.md).
- Add tests: registration with a valid link code but a signature from a different key is rejected; a tampered `engineVersion` invalidates the signature.
- `verifyHeartbeat({ rawBody, signatureHeader, engineId, publicKey, lastSeq, now })` returns `{ kind: 'accepted', heartbeat } | { kind: 'bad-signature-header' } | { kind: 'bad-signature' } | { kind: 'invalid-body' } | { kind: 'engine-mismatch' } | { kind: 'replayed-seq' } | { kind: 'stale-ts' }`. Order: header, signature over raw bytes, then JSON parse and schema, then path `engineId` equals body `engineId`, then `seq > lastSeq`, then `|now − ts| ≤ 120 s`. Never parse before the signature verifies. `now` comes from the caller's `Clock`.
- Heartbeat body cap: 4 KiB; reject larger before verifying.
- `seq` only has to increase strictly. Engines should send `max(lastSeq + 1, Date.now())` so an engine that loses its state but keeps its key is not locked out; document this in the package README and in E-01.
- Schema bounds: `seq` safe integer ≥ 0; `uptimeS` ≥ 0; `diskPct`, `ramPct` in {0, 10, …, 100}; `agents`, `members` 0–1,000,000; `cpuLoad` and `update` closed enums. No string field accepts free text: `version` is SemVer, `engineId` is branded.
- The registration request carries `v: 1` like every JSON message (ADR 0010; spec updated).

## Acceptance criteria

- [ ] `verifyHeartbeat` has a test per outcome, plus: signature valid but body re-serialised with different whitespace fails; `seq` equal to `lastSeq` is replayed; `ts` exactly 120 s off is accepted and 121 s is stale (both directions); unknown field rejected after a valid signature; 4 KiB + 1 rejected.
- [ ] Property test: `buildHeartbeat` output always parses with `Heartbeat` and percentages are multiples of ten for any input 0–100.
- [ ] `resolveRoutableHostnames`: a claim for another engine ID, a claim signed by another key, a claim for a different hostname, and a duplicate hostname are all dropped; the default hostname needs no claim; a `suspended` entry still parses.
- [ ] `checkRegistrationResponse` tests for each outcome.
- [ ] `LinkCode`: 25 and 27 characters, uppercase, padding, `0`/`1`/`8`/`9` and a non-canonical last character are rejected; `generateLinkCode` output always parses.
- [ ] Golden vectors (a signed heartbeat body and header with a fixed key) checked in for the engine team.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Decided 2026-10-19 (ADR 0010, spec updated): the heartbeat signature covers `signingInput('ptbk-heartbeat-v1', sha256Base64Url(rawBody))`, and the registration request carries `v: 1`. Add a test that a signature made over the raw body without the context is rejected.
- The enterprise table says the heartbeat carries an org ID; Interface 4 does not. Left out until decided.
