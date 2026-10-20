# @ptbk/engine-api

The engine HTTP API that engine-ui consumes and every engine implements (contract version `ENGINE_API_VERSION`, paths under `ENGINE_API_PREFIX` = `/api/v1`).

MIT, Web APIs only, no imports from `@ptbk/*`, so it can move to the public repo unchanged ([ADR 0002](../../docs/adr/0002-public-private-split.md)). Plan: tasks C-04 (core) and C-07 (capabilities, activity, tolerant reading).

## What is in it

- **Schemas** (zod 4, strict: engines reject unknown request fields and must not send undeclared response fields), one file per resource: `me`, `engine`, `agents` (with source, revisions and draft run control), `events`, `folders`, `chats`, `members` (invites and role changes are `draft`), `api-tokens`, `settings`, `passkeys`, `sessions`, `secrets`, `files`, `security`, `audit`, and `GET /chats` across agents. Branded IDs and shared types live in `common.ts`; `ProblemDetails` is RFC 9457 with a closed `code` (`problem-codes.ts`).
- **Capabilities** ([ADR 0016](../../docs/adr/0016-engine-capabilities.md)), one module each under `src/capabilities/`: `runs@1`, `files@1` (C-04's file routes moved here), `triggers@1`, `integrations@1`. `GET /engine` advertises them in `capabilities` (absent on API 1.0 engines, read as `[]`); `supports(engineInfo, ref)` matches an exact version and ignores unknown IDs. Every capability route carries `capability`, and an engine that does not advertise it answers 404 `capability-not-supported`. Integration `kind` is an open set: a client reads an unknown kind as `{ kind: 'unknown', rawKind }` without `config`.
- **Activity** (`src/capabilities/activity.ts`): a union discriminated on `kind` and `v`, served by `GET /activity` and as `activity` events. `parseActivity` never throws and gives `known`, `unknown` (unknown kind or higher `v`), `invalid` (a known kind breaking its schema) or `dropped` (no valid base); pages drop and count the last. Each area is shown only with its read permission (`ACTIVITY_PERMISSIONS`). Items carry IDs and short names, never content.
- **Tolerant reading** (ADR 0010 §3): clients read responses with `toTolerant(schema)`, which strips unknown fields at every depth and then validates every known field strictly, or with a route's `read` schema where an open set needs more (activity, integrations, events). Unknown event types are skipped. Engines, the in-memory engine and conformance check responses against the strict `schema`, so drift is caught where it starts.
- **`ENGINE_API_ROUTES`**: every operation with its method, path, required `Permission` (`null` only for `/me`, `/me/**` and `/engine`; routes under `/me` act only on the caller's own passkeys and sessions and answer 404, never 403, for anyone else's), schemas, success response, route-specific problems and the `stepUp` and `draft` flags. Framework-agnostic: the client, the OpenAPI document, the conformance suite and any engine (Hono, Fastify) are driven by it.
- **`EngineApiClient`**: the port engine-ui depends on. Every method takes an `AbortSignal` and resolves to `{ kind: 'ok', data } | { kind: 'problem', problem }`; network failures, timeouts (`TimeoutError`) and aborts reject, and a response outside the contract rejects with `EngineApiContractError`.
  - `createFetchEngineApiClient({ baseUrl, fetch, timeoutMs })`: same-origin credentials, so the gateway's `__Host-` session cookie is the only credential.
  - `createInMemoryEngineApiClient({ seed, clock, member, stepUp, replyScript, capabilities })`: plain maps with the same observable rules, for UI tests and offline development. It carries `IN_MEMORY_CLIENT_MARKER`, so a production bundle can prove it is absent. `capabilities` defaults to all four. Chat messages start `web` runs; `createDemoSeed(now)` gives believable data for every capability.
  - `createInMemoryEngine(options)` returns that client with a test-only `controller` (`appendActivity`, `advanceRun`, `fireTrigger`, `emit`) for what the engine does on its own, stamped by the injected clock.
- **SSE**: `parseSseStream`, `createSseParser` and `encodeSseMessage`. Streams carry each event's `type` as the SSE `event` field and the event as JSON `data`; they resume after `Last-Event-ID` (reply streams use the delta `seq` as id).
- **Constants**: `ENGINE_UI_CSP` (the one CSP string the bundle, the mock engine, conformance and the real engine share), the gateway paths, `ENGINE_RESERVED_PATHS` and the size and paging limits.

## Tests and coverage

`bun run --filter @ptbk/engine-api test` runs Vitest with coverage; `vitest.config.ts` requires at least 90% of lines and branches under `src/` (test support in `src/testing/` is excluded; the OpenAPI writer in `scripts/` is outside `src/` and is exercised by regenerating the document).

## OpenAPI

`openapi.json` is generated from the route table with `z.toJSONSchema()` and committed. Each operation lists its `x-required-permission`, `x-capability` (capability routes), `x-step-up` and `x-draft` flags and its problem responses (`x-problem-codes`). A test fails when the file is stale; regenerate it with:

```sh
bun run --filter @ptbk/engine-api openapi
```

## Open points

To confirm with the engine team before the contract freezes (E-02): the base path, `permanentId` semantics (assumed stable across renames), `profile` being derived from the book (assumed read-only), the file upload format, the permission list, which further routes need step-up, and what run control means for coding agents. For C-07: the four capability models follow the predecessor and need the engine team's review before E-01; `GET /activity` uses `agents.read` (an `activity.read` permission is the alternative); cron expressions are numeric five-field only.
