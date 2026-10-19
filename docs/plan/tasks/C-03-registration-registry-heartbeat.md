# C-03. Registration, registry lookup and heartbeat contracts

- **Lane:** Contracts · **Module:** `packages/protocol` · **Milestone:** M1
- **Depends on:** C-01
- **Status:** todo
- **Spec:** Interfaces (draft) 1, 2 and 4, What our platform can and cannot do (Heartbeat), Pairing and identity (First setup); ADRs: [0002](../../adr/0002-public-private-split.md), [0014](../../adr/0014-cryptography.md)

## Goal

`@ptbk/protocol` exports strict schemas and pure helpers for engine registration, the relay's registry lookup and the signed heartbeat, including the verification the dashboard runs on every heartbeat.

## Context

These are the only messages between an engine and our dashboard, so the heartbeat schema is the public promise of what we learn about an engine: numbers only, no names or free text. The dashboard (D-03, D-04, D-05), the relay's HTTP registry adapter (D-04) and the mock engine (M-06) all build on these. Heartbeat verification must work on raw bytes, because the signature covers the body exactly as sent.

## Scope

- `src/registration.ts`: `RegisterEngineRequest { v: 1, linkCode, enginePublicKey: Ed25519PublicKey, engineVersion: EngineVersion, mode: 'tunnel' | 'direct', sig: Ed25519Signature }` (local engines never register, so there is no `local` mode here) where `sig` covers `signingInput('ptbk-register-v1', v, linkCode, enginePublicKey (raw 32 bytes), engineVersion, mode)` with `v` as its decimal string (proof of key possession: nobody can register someone else's key with a stolen link code, and `mode` cannot be flipped in transit); `signRegistration(signer, request)` and `verifyRegistration(request)`, `RegisterEngineResponse { engineId, hostname, relays: Hostname[] (1–16, unique) }`, path constant `REGISTER_PATH = '/v1/engines/register'`, and `checkRegistrationResponse(response, publicKey, engineDomain)` returning `{ kind: 'ok' } | { kind: 'engine-id-mismatch' } | { kind: 'hostname-mismatch' }` so the engine refuses a dashboard that hands it someone else's identity.
- `src/link-code.ts`: `LinkCode` branded schema: 128 random bits as lowercase RFC 4648 base32 without padding, so exactly 26 characters of `[a-z2-7]` whose last character carries zero trailing bits (canonical, one accepted spelling per code). No grouping or separators: the code is copied, not typed. `generateLinkCode(random: Random)` takes C-01's `Random` port so it stays testable; D-03 hashes and stores it.
- `src/registry.ts`: `RegistryEntry { enginePublicKey, hostnames: Hostname[], claims: HostnameClaim[], status: 'active' | 'suspended' }`, `HostnameClaim { hostname, sig }`, path builder `registryPath(engineId)` = `/internal/v1/engines/{engineId}`, and `resolveRoutableHostnames(engineId, entry, engineDomain)`: returns the default hostname plus every custom hostname whose claim verifies; drops the rest and reports them (`{ hostnames, dropped: Hostname[] }`). This is the single claim-verification implementation: the relay (R-02, R-03) calls it on every registry read and the dashboard (D-04) calls it before storing or serving claims; neither reimplements it. The claim format and verification stay as they are; a verified claim is necessary but not sufficient for routing (see custom hostnames below).
- `src/custom-hostname.ts`: `expectedCnameTarget(engineId, engineDomain): Hostname` (pure; equals `defaultHostname(engineId, engineDomain)` from C-01): the exact name a customer's custom hostname must CNAME to. The relay's DNS check (via its `DnsResolver` port, with caching) uses this helper; the DNS lookup itself lives in the relay, not here.
- `src/heartbeat.ts`: `Heartbeat` schema per spec (`v: 1, engineId, seq, ts, version, uptimeS, diskPct, ramPct, cpuLoad, update, agents, members`); `HEARTBEAT_SIGNATURE_HEADER = 'Ptbk-Signature'`; `parseSignatureHeader('ed25519=<b64url>')`; `buildHeartbeat(input)` that rounds percentages to tens and returns the exact bytes to send; `signHeartbeat(signer, bodyBytes)`, signing `signingInput('ptbk-heartbeat-v1', sha256(bodyBytes))` with the digest as raw 32 bytes (ADR 0010, 0014; the header carries the signature in `Ptbk-Signature: ed25519=<b64url>`); `verifyHeartbeat(...)` (below).
- `src/problem.ts`: RFC 9457 `ProblemDetails` schema (`type, title, status, detail?, code`) used for dashboard API errors (same shape as C-04, defined here separately because `engine-api` cannot import `protocol`), and `REGISTRATION_ERROR_CODE`: `invalid-link-code` (one code for a bad, expired or used link code, so the dashboard is no oracle), `engine-exists` (409: the engine ID derived from the key is registered to another organisation), `engine-suspended` (403: the engine is suspended or owner-revoked), `engine-limit`, `bad-signature`.

## Out of scope

- Dashboard endpoints, storage, link-code hashing (D-03), relay authentication to the registry (D-04), Durable Object state (D-05), the engine-side client (M-06).

## Design notes

- Decided 2026-10-19 (spec updated): registration is signed by the engine key; the registry entry carries `claims: [{ hostname, sig }]`. The relay looks engines up by engine ID at tunnel auth and keeps a hostname → engine map only for engines connected to it (refreshed every 5 minutes), so no lookup by hostname is needed.
- **Protocol design:** follows [ADR 0010](../../adr/0010-protocol-design-principles.md).
- Add tests: registration with a valid link code but a signature from a different key is rejected; a tampered `engineVersion` or `mode` invalidates the signature; a signature over the base64url text of the key instead of its raw bytes is rejected.
- `verifyHeartbeat({ rawBody, signatureHeader, engineId, publicKey, lastSeq, now })` returns `{ kind: 'accepted', heartbeat } | { kind: 'bad-signature-header' } | { kind: 'bad-signature' } | { kind: 'invalid-body' } | { kind: 'engine-mismatch' } | { kind: 'replayed-seq' } | { kind: 'stale-ts', serverTime: Timestamp }`. The dashboard returns `serverTime` in the `stale-ts` problem body, so the engine can show its clock skew in the security panel. Order: header, signature over raw bytes, then JSON parse and schema, then path `engineId` equals body `engineId`, then `seq > lastSeq`, then `|now − ts| ≤ 120 s`. Never parse before the signature verifies. `now` comes from the caller's `Clock`.
- Heartbeat body cap: 4 KiB; reject larger before verifying.
- `seq` only has to increase strictly. Engines should send `max(lastSeq + 1, Date.now())` so an engine that loses its state but keeps its key is not locked out; document this in the package README and in E-01.
- Schema bounds: `seq` safe integer ≥ 0; `uptimeS` ≥ 0; `diskPct`, `ramPct` in {0, 10, …, 100}; `agents`, `members` 0–1,000,000; `cpuLoad` and `update` closed enums. No string field accepts free text: `version` is SemVer, `engineId` is branded.
- The registration request carries `v: 1` like every JSON message (ADR 0010; spec updated).
- **Same engine ID, different key** cannot happen: the engine ID is derived from the key. Re-registration of a key whose derived engine ID already exists (D-03 implements it; C-03, D-03 and E-01 state the same rule): same organisation as the link code and the engine is active → idempotent 200 returning the existing engine (`RegisterEngineResponse` for it), the link code is consumed, and the engine row's `engineVersion` and `mode` are updated from the signed request; another organisation → 409 `engine-exists` and the link code stays unused; engine suspended or owner-revoked → 403 `engine-suspended`. Re-registration after a key loss means a new key and a new identity (E-01).
- **Custom hostnames (decided 2026-10-19, ADR 0014):** the customer's DNS must have a CNAME from the custom hostname to `expectedCnameTarget(engineId, engineDomain)`, i.e. `<engineId>.<engine domain>`, not to a relay. The relay routes a custom hostname only if its claim verifies (`resolveRoutableHostnames`) **and** its CNAME resolves to exactly that engine's default hostname; it re-checks at the 5-minute registry refresh and, on DNS failure, keeps the last positive result for up to the 24 h stale limit. Two connected engines claiming the same hostname: the relay routes it for neither and logs `hostname.conflict`. Apex domains are not supported in v0 (no CNAME at the apex). This protects a customer's domain even against a compromised dashboard, which can serve registry entries but cannot change the customer's DNS.

## Acceptance criteria

- [ ] `verifyHeartbeat` has a test per outcome, plus: signature valid but body re-serialised with different whitespace fails; `seq` equal to `lastSeq` is replayed; `ts` exactly 120 s off is accepted and 121 s is stale (both directions); unknown field rejected after a valid signature; 4 KiB + 1 rejected.
- [ ] Property test: `buildHeartbeat` output always parses with `Heartbeat` and percentages are multiples of ten for any input 0–100.
- [ ] `resolveRoutableHostnames`: a claim for another engine ID, a claim signed by another key, a claim for a different hostname, and a duplicate hostname are all dropped; the default hostname needs no claim; a `suspended` entry still parses.
- [ ] `checkRegistrationResponse` tests for each outcome.
- [ ] `expectedCnameTarget` equals `defaultHostname` for the same inputs and always parses as `Hostname`.
- [ ] `stale-ts` carries the `serverTime` passed in as `now`.
- [ ] `LinkCode`: 25 and 27 characters, uppercase, padding, `0`/`1`/`8`/`9` and a non-canonical last character are rejected; `generateLinkCode` output always parses.
- [ ] Golden vectors (a signed heartbeat body and header, and a signed registration request, with a fixed key and the `signingInput` hex) checked in for the engine team.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Decided 2026-10-19 (ADR 0010, 0014): the heartbeat signature covers `signingInput('ptbk-heartbeat-v1', sha256(rawBody))` with the raw 32-byte digest, and the registration request carries `v: 1`. The spec's Interface 4 still describes the old input and must be fixed to match (the PR notes it). Add tests that a signature over the raw body without the context, or over the base64url digest text, is rejected.
- Link codes are 128 bits on purpose: they are short-lived, single-use and rate-limited, and copied rather than typed, so a longer code buys nothing.
- The enterprise table says the heartbeat carries an org ID; Interface 4 does not. Left out until decided.
