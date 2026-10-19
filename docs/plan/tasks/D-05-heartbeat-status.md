# D-05. Heartbeat ingest, Durable Object per engine, offline alerts

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-03 · **Unblocks:** D-06, I-05
- **Status:** todo
- **Spec:** What our platform can and cannot do (Heartbeat); Interfaces (draft) 4; Operations (Engine offline; Notifications without us); Metadata we still see; ADRs: [0006](../../adr/) (Organizations, members and roles from day one)

## Goal

Engines post signed heartbeats to `POST /v1/engines/{engineId}/heartbeat`; a Durable Object per engine keeps the latest status, and after 3 missed heartbeats it emails the engine's organization owners an offline alert through the `EmailSender` port.

## Context

The heartbeat is the platform's only input from a running engine: numbers only, signed by the engine key, one way. It must not be forgeable or replayable (docs/security.md). The Durable Object serializes everything for one engine, which makes the `seq` check race-free and gives us per-engine alarms for free. `EmailSender` (Cloudflare Email Service adapter, in-memory fake) comes from D-02; this task adds a template. Schemas and signature verification come from `packages/protocol` (C-01, C-03); never re-implement them.

## Scope

- Durable Object class `EngineStatus` exported from `src/worker.ts`, binding `ENGINE_STATUS`, SQLite-backed (`new_sqlite_classes` migration tag `v1` in `wrangler.jsonc`), addressed by `idFromName(engineId)`.
- RPC methods on `EngineStatus`, each delegating to a pure domain state machine in `src/domain/status/`:
  - `recordHeartbeat({ engineId, orgId, seq, ts, receivedAt, payload }) → { kind: 'accepted' } | { kind: 'replay' }` (`replay` when `seq <= lastSeq`);
  - `getStatus() → EngineStatusSnapshot` = `{ state: 'never-seen' } | { state: 'online' | 'offline', lastSeenAt, lastSeq, payload, offlineSince? }`;
  - `reset()` deletes all storage (for engine removal later).
- `alarm()`: if `now - lastSeenAt >= missedLimit * intervalS` (defaults 3 and 60 s, plus 15 s grace) and no alert has been sent for this outage, mark `offline`, resolve recipients and send one `engine-offline` email. A later heartbeat sets `online` and arms the next outage. Failed sends retry with backoff up to 3 times. Thirty days after the last heartbeat, the alarm deletes the stored payload (spec retention) and keeps only `state` and `lastSeenAt`.
- Route in the API router, in this order: per-IP and per-engine rate limits (per engine 5 per minute) → body cap 2 KiB (413) → engine ID path parse (400) → `Ptbk-Signature: ed25519=<base64url>` header parse (401) → load engine from D1 (404 unknown, 403 suspended) → verify the signature over the exact raw body bytes with the protocol function (401) → JSON parse and strict C-03 schema (400) → `body.engineId` equals the path (400) → `|now - ts| <= 120 s` (401 `stale-timestamp`) → `recordHeartbeat` (409 on `replay`) → success per C-03 (204 if C-03 says nothing).
- `engine-offline` email template in English and Czech: engine ID, hostname, last seen time, link to the dashboard engine page. Nothing else; there is nothing else to send.
- `AlertRecipients` port: `forEngineOffline(orgId, signal) → readonly { email, locale }[]`; the D1 adapter returns the org's `owner` members with verified emails. Later roles or settings change only this adapter.

## Out of scope

- The engine list and detail UI (D-06); metrics and uptime checks (I-04); "back online" emails (open point).
- The engine-side heartbeat client (M-06).

## Design notes

- Read the body once as `ArrayBuffer`, verify, then decode and parse; never re-serialize JSON for verification.
- Verify before touching the Durable Object, so unauthenticated traffic never wakes it.
- The Worker passes `orgId` from the D1 engine row into the DO, so the alarm never needs an org lookup by engine for scoping.
- Every `recordHeartbeat` calls `setAlarm(receivedAt + missedLimit * intervalS + grace)`, replacing the previous alarm.
- Store only C-03's numeric fields (`version`, `uptimeS`, `diskPct`, `ramPct`, `cpuLoad`, `update`, `agents`, `members`) plus `seq`, `ts`, `receivedAt`. Do not store the signature, IP or headers.
- Log engine ID and outcome kind only.

## Acceptance criteria

- [ ] Domain unit tests: accepted; equal and lower `seq` → replay; offline after 3 missed intervals (injected `Clock`); exactly one email per outage; heartbeat after offline → online and a new outage emails again; payload purged after 30 days.
- [ ] Workers tests (`SELF.fetch`, `runInDurableObject`, `runDurableObjectAlarm`), each a case: valid heartbeat → success and `getStatus()` shows it; missing header; wrong scheme (`rsa=`); signature by another key; body altered after signing; replayed body → 409; `ts` 3 minutes old and 3 minutes ahead → 401; path/body engine ID mismatch → 400; unknown field → 400; unknown engine → 404; suspended engine → 403; 3 KiB body → 413; rate limit → 429.
- [ ] Alarm test with the in-memory `EmailSender`: after 3 missed heartbeats one `engine-offline` message goes to the org owner in the owner's locale; none to members of other orgs.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- An engine that loses its state but keeps its key restarts `seq` and is rejected until it passes the old value. C-03 and E-01 should define `seq` so it survives that (for example milliseconds since epoch, still strictly increasing). Flag it there; do not relax the check here.
- Whether to send "back online" emails, and alert preferences per user, are product decisions.
- Responding 403 to suspended engines means their status goes stale in the dashboard; confirm with I-05.
