# D-05. Heartbeat ingest, Durable Object per engine, offline alerts

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-03
- **Status:** done (#53)
- **Spec:** What our platform can and cannot do (Heartbeat); Interfaces (draft) 4; Operations (Engine offline; Notifications without us); Metadata we still see; ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0014](../../adr/0014-cryptography.md)

## Goal

Engines post signed heartbeats to `POST /v1/engines/{engineId}/heartbeat`; a Durable Object per engine keeps the latest status, and after 3 missed heartbeats it emails the engine's organization owners an offline alert through the `EmailSender` port.

## Context

The heartbeat is the platform's only input from a running engine: numbers only, signed by the engine key, one way. It must not be forgeable or replayable (docs/security.md). The Durable Object serializes everything for one engine, which makes the `seq` check race-free and gives us per-engine alarms for free. `EmailSender` (Cloudflare Email Service adapter, in-memory fake) comes from D-02; this task adds a template. Schemas and signature verification come from `packages/protocol` (C-01, C-03); never re-implement them.

## Scope

- Durable Object class `EngineStatus` as a named export of `src/worker.ts` next to the Hono default export, binding `ENGINE_STATUS`, SQLite-backed (`new_sqlite_classes` migration tag `v1` in `wrangler.jsonc`), addressed by `idFromName(engineId)`. Durable Object changes keep using wrangler migration tags; the DO's own storage is not part of the D1 schema or drizzle-kit.
- RPC methods on `EngineStatus`, each delegating to a pure domain state machine in `src/domain/status/`:
  - `recordHeartbeat({ engineId, orgId, publicKey, rawBody, signatureHeader, receivedAt })` returns C-03's `verifyHeartbeat` outcome: inside the DO, call `verifyHeartbeat({ rawBody, signatureHeader, engineId, publicKey, lastSeq, now })` with the stored `lastSeq` and the injected `Clock`, store the heartbeat and advance `lastSeq` only on `accepted`. The check order (header, signature, parse and schema, engine ID, `seq > lastSeq`, timestamp within 120 s) is C-03's; never re-implement it. The signature covers `signingInput('ptbk-heartbeat-v1', SHA-256(rawBody))` (the hash as raw bytes, ADR 0014) and is checked with the protocol's strict Ed25519 verification;
  - `getStatus() → EngineStatusSnapshot` = `{ state: 'never-seen' } | { state: 'online' | 'offline', lastSeenAt, lastSeq, payload, offlineSince? }`;
  - `reset()` deletes all storage (for engine removal later).
- `alarm()`: if `now - lastSeenAt >= missedLimit * intervalS` (defaults 3 and 60 s, plus 15 s grace; `missedLimit`, `intervalS`, grace and the per-engine rate limit are config values, and the e2e stack uses a 15 s heartbeat interval) and no alert has been sent for this outage, mark `offline`, resolve recipients and send one `engine-offline` email. A later heartbeat sets `online` and arms the next outage. Failed sends retry with backoff up to 3 times. Thirty days after the last heartbeat, the alarm deletes the stored payload (spec retention) and keeps only `state` and `lastSeenAt`.
- Route in the Hono `/v1` router, in this order: per-IP and per-engine rate limits (per engine configurable, default 5 per minute; 429) → body cap 4 KiB per C-03 (413) → engine ID path parse (400) → load engine from D1 (404 unknown, 403 suspended) → `recordHeartbeat` on the engine's DO, which runs `verifyHeartbeat` → map its outcome: `accepted` → success per C-03 (204 if C-03 says nothing); `bad-signature-header` and `bad-signature` → 401; `invalid-body` and `engine-mismatch` → 400; `replayed-seq` → 409; `stale-ts` → 401 `stale-timestamp` with the extension member `serverTime` (the injected `Clock`, RFC 3339 UTC), so the engine can show its clock skew. Errors are C-03 `ProblemDetails`.
- `engine-offline` email template in English and Czech: engine ID, hostname, last seen time, link to the dashboard engine page. Nothing else; there is nothing else to send.
- `AlertRecipients` port: `forEngineOffline(orgId, signal) → readonly { email, locale }[]`; the D1 adapter (Drizzle, in `src/adapters/db/`) returns the org's `owner` members with verified emails. Later roles or settings change only this adapter.

## Out of scope

- The engine list and detail UI (D-06); metrics and uptime checks (I-04); "back online" emails (open point).
- The engine-side heartbeat client (M-06).

## Design notes

- Read the body once as `ArrayBuffer` (`c.req.arrayBuffer()`), check the 4 KiB cap, and pass the exact bytes to the DO; `verifyHeartbeat` parses only after the signature verifies, so this route uses no JSON validator middleware, which would parse first.
- Verification runs inside the DO because `seq > lastSeq` needs the DO's serialized state; unknown and suspended engines are rejected from D1 before the DO is touched, and the per-IP and per-engine rate limits run first, so anonymous traffic cannot wake arbitrary DOs.
- The Worker passes `orgId` from the D1 engine row into the DO, so the alarm never needs an org lookup by engine for scoping.
- Every accepted heartbeat calls `setAlarm(receivedAt + missedLimit * intervalS + grace)`, replacing the previous alarm.
- Store only C-03's numeric fields (`version`, `uptimeS`, `diskPct`, `ramPct`, `cpuLoad`, `update`, `agents`, `members`) plus `seq`, `ts`, `receivedAt`. Do not store the signature, IP or headers.
- Log engine ID and outcome kind only.

## Acceptance criteria

- [x] Domain unit tests: accepted; equal and lower `seq` → `replayed-seq` (through `verifyHeartbeat` with the stored `lastSeq`); offline after 3 missed intervals (injected `Clock`); exactly one email per outage; heartbeat after offline → online and a new outage emails again; payload purged after 30 days.
- [x] Workers tests (`SELF.fetch`, `runInDurableObject`, `runDurableObjectAlarm`), each a case: valid heartbeat → success and `getStatus()` shows it; missing header; wrong scheme (`rsa=`); signature by another key; body altered after signing; replayed body → 409; `ts` 3 minutes old and 3 minutes ahead → 401 `stale-timestamp` whose `serverTime` equals the fake clock; path/body engine ID mismatch → 400; unknown field → 400; unknown engine → 404; suspended engine → 403; 4 KiB + 1 byte body → 413; rate limit → 429 at the configured limit.
- [x] Alarm test with the in-memory `EmailSender`: after 3 missed heartbeats one `engine-offline` message goes to the org owner in the owner's locale; none to members of other orgs.
- [x] `bun run check` passes.
- [x] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Whether to send "back online" emails, and alert preferences per user, are product decisions.
- Responding 403 to suspended engines means their status goes stale in the dashboard; confirm with I-05.
