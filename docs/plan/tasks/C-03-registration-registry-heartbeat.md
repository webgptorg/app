# C-03. Registration, registry lookup and heartbeat contracts

- **Lane:** Contracts · **Module:** `packages/protocol` · **Milestone:** M1
- **Depends on:** C-01 · **Unblocks:** D-03, M-06, E-01 (and through D-03: D-04, D-05)
- **Status:** todo
- **Spec:** Interfaces (draft) 1, 2 and 4, What our platform can and cannot do (Heartbeat), Pairing and identity (First setup); ADRs: [0002](../../adr/0002-public-private-split.md)

## Goal

`@ptbk/protocol` exports strict schemas and pure helpers for engine registration, the relay's registry lookup and the signed heartbeat, including the verification the dashboard runs on every heartbeat.

## Context

These are the only messages between an engine and our dashboard, so the heartbeat schema is the public promise of what we learn about an engine: numbers only, no names or free text. The dashboard (D-03, D-04, D-05), the relay's HTTP registry adapter (D-04) and the mock engine (M-06) all build on these. Heartbeat verification must work on raw bytes, because the signature covers the body exactly as sent.

## Scope

- `src/registration.ts`: `RegisterEngineRequest { linkCode, enginePublicKey: Ed25519PublicKey, engineVersion: EngineVersion, mode: 'tunnel' | 'direct', sig: Ed25519Signature }` where `sig` covers `signingInput('ptbk-register-v1', linkCode, enginePublicKey, engineVersion)` (proof of key possession: nobody can register someone else's key with a stolen link code); `signRegistration(signer, request)` and `verifyRegistration(request)`, `RegisterEngineResponse { engineId, hostname, relays: Hostname[] (1–16, unique) }`, path constant `REGISTER_PATH = '/v1/engines/register'`, and `checkRegistrationResponse(response, publicKey, engineDomain)` returning `{ kind: 'ok' } | { kind: 'engine-id-mismatch' } | { kind: 'hostname-mismatch' }` so the engine refuses a dashboard that hands it someone else's identity.
- `LinkCode` branded schema (format agreed with D-03; propose 128-bit base32, grouped for typing).
- `src/registry.ts`: `RegistryEntry { enginePublicKey, hostnames: Hostname[], claims: HostnameClaim[], status: 'active' | 'suspended' }`, `HostnameClaim { hostname, sig }`, path builder `registryPath(engineId)` = `/internal/v1/engines/{engineId}`, and `resolveRoutableHostnames(engineId, entry, engineDomain)`: returns the default hostname plus every custom hostname whose claim verifies; drops the rest and reports them (`{ hostnames, dropped: Hostname[] }`).
- `src/heartbeat.ts`: `Heartbeat` schema per spec (`v: 1, engineId, seq, ts, version, uptimeS, diskPct, ramPct, cpuLoad, update, agents, members`); `HEARTBEAT_SIGNATURE_HEADER = 'Ptbk-Signature'`; `parseSignatureHeader('ed25519=<b64url>')`; `buildHeartbeat(input)` that rounds percentages to tens and returns the exact bytes to send; `signHeartbeat(signer, bodyBytes)`; `verifyHeartbeat(...)` (below).
- `src/problem.ts`: RFC 9457 `ProblemDetails` schema (`type, title, status, detail?, code`) used for dashboard API errors (same shape as C-04, defined here separately because `engine-api` cannot import `protocol`).

## Out of scope

- Dashboard endpoints, storage, link-code hashing (D-03), relay authentication to the registry (D-04), Durable Object state (D-05), the engine-side client (M-06).

## Design notes

- Decided 2026-10-19 (spec updated): registration is signed by the engine key; the registry entry carries `claims: [{ hostname, sig }]`. The relay looks engines up by engine ID at tunnel auth and keeps a hostname → engine map only for engines connected to it (refreshed every 5 minutes), so no lookup by hostname is needed.
- Add tests: registration with a valid link code but a signature from a different key is rejected; a tampered `engineVersion` invalidates the signature.

- `verifyHeartbeat({ rawBody, signatureHeader, engineId, publicKey, lastSeq, now })` returns `{ kind: 'accepted', heartbeat } | { kind: 'bad-signature-header' } | { kind: 'bad-signature' } | { kind: 'invalid-body' } | { kind: 'engine-mismatch' } | { kind: 'replayed-seq' } | { kind: 'stale-ts' }`. Order: header, signature over raw bytes, then JSON parse and schema, then path `engineId` equals body `engineId`, then `seq > lastSeq`, then `|now − ts| ≤ 120 s`. Never parse before the signature verifies. `now` comes from the caller's `Clock`.
- Heartbeat body cap: 4 KiB; reject larger before verifying.
- `seq` only has to increase strictly. Engines should send `max(lastSeq + 1, Date.now())` so an engine that loses its state but keeps its key is not locked out; document this in the package README and in E-01.
- Schema bounds: `seq` safe integer ≥ 0; `uptimeS` ≥ 0; `diskPct`, `ramPct` in {0, 10, …, 100}; `agents`, `members` 0–1,000,000; `cpuLoad` and `update` closed enums. No string field accepts free text: `version` is SemVer, `engineId` is branded.
- Registration body has no `v` field (versioned by path `/v1`), matching the spec.

## Acceptance criteria

- [ ] `verifyHeartbeat` has a test per outcome, plus: signature valid but body re-serialised with different whitespace fails; `seq` equal to `lastSeq` is replayed; `ts` exactly 120 s off is accepted and 121 s is stale (both directions); unknown field rejected after a valid signature; 4 KiB + 1 rejected.
- [ ] Property test: `buildHeartbeat` output always parses with `Heartbeat` and percentages are multiples of ten for any input 0–100.
- [ ] `resolveRoutableHostnames`: a claim for another engine ID, a claim signed by another key, a claim for a different hostname, and a duplicate hostname are all dropped; the default hostname needs no claim; a `suspended` entry still parses.
- [ ] `checkRegistrationResponse` tests for each outcome.
- [ ] Golden vectors (a signed heartbeat body and header with a fixed key) checked in for the engine team.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The heartbeat signature covers the raw body with no context prefix, unlike the other signatures. Body JSON cannot collide with a `ptbk-…|` signing input, but domain separation is cleaner; put it on the crypto review list (I-06) rather than diverging from the spec here.

- **Registry by hostname:** the relay sees only the SNI. Default hostnames carry the engine ID in their first label, but custom hostnames need a lookup by hostname that the spec does not define. Propose `GET /internal/v1/hostnames/{hostname}` returning the same entry plus `engineId`; agree with D-04 and R-02.
- The enterprise table says the heartbeat carries an org ID; Interface 4 does not. Left out until decided. `mode: 'local'` is excluded from registration on the assumption local engines do not register.
