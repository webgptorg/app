# C-18. AI tools contract: status, checks and signing in again from the browser

- **Lane:** C · **Module:** `packages/engine-api`, `packages/conformance` · **Milestone:** M5
- **Depends on:** C-15
- **Status:** done (pushed to main)
- **Spec:** Access, transport and zero trust; ADRs: [0016](../../adr/0016-engine-capabilities.md)

## Goal

`ai-tools@1`: the browser can list a project's AI tools (the engine's harnesses) with their status, check one with a real call, and sign one in again or give it an API key, so a project on a server never needs a terminal after a provider sign-in expires. The engine team can build it from the contract, the reference engine and the conformance checks alone.

## Context

Seb's run on a Hetzner box (AGENT_BRIEF 2026-11-23, item 5) ended with a Claude sign-in that expired three minutes after setup and no way back but SSH. The brief's stopgap, reopening onboarding with a `harness-login` step, would mix setup with maintenance and hide the cause from Home and the chat. This contract replaces it and reuses onboarding's `harness-login` and `secret` prompts, so the engine and the UI build the sign-in once. Contract changes go in place before E-02, with an AGENT_BRIEF entry.

## Scope

- `capabilities/ai-tools.ts`: `AiTool { id, name, version, status, auth, signInMethods, checkedAt, checking, problem }` with closed statuses, auth methods and problem codes, tolerant readers (unknown values read as `unknown`); `AiToolSignIn` with onboarding's prompts; eight routes (list, get, check, start, read, answer and cancel a sign-in, sign out) under `ai-tools.read` and `ai-tools.manage`, step-up on start and sign-out.
- New permissions, problem codes (`ai-tool-not-installed`, `ai-tool-sign-in-stale`, `ai-tool-method-unsupported`, `ai-tool-sign-in-required` with the `aiToolId` extension), `ChatRecheck.aiToolId`, event `ai-tool.changed`, audit actions and target kind, typed client `client.aiTools`, OpenAPI. `ENGINE_API_VERSION` stays 1.15.0: the change is additive and the capability flag gates the UI (as for C-16 and C-17), while a bump would make every current engine refuse the next UI release.
- The in-memory reference engine: three fake tools (an account sign-in with a returned code, a device code, one not installed), key shapes per provider, a sign-in bound to its gateway session, verification before switching credentials, levers to expire and renew a sign-in, fail checks and answer a device login; a new chat turn fails with a recheck naming the tool while the tool chats run on needs a sign-in.
- Conformance `engine-api.ai-tools.check`, `.permissions`, `.sign-in-flow`, `.secret-never-echoed` and `.sign-in-required` (with the new `ConformanceTarget.aiTools` levers), each skipping without the capability and failing against a fake that breaks it; the generic permission, audit and input checks know the new routes.
- Docs: [ai-tools.md](../../engine-integration/ai-tools.md), engine-api.md, checklist rows ENG-126 and ENG-127, and the AGENT_BRIEF entry of 2026-11-24 with test cases AT-01 to AT-16.

## Out of scope

- The mock engine (M-13) and the UI (U-25).
- Installing a tool from the browser; choosing which tool an agent runs on; `claude setup-token` as a third method (open question in ai-tools.md).

## Design notes

- `check` needs only `ai-tools.read`: it changes no credential, and admins diagnosing a project need it; engines rate-limit it.
- A sign-in belongs to the gateway session that started it (404 for any other), and new credentials replace old ones only after a real call verified them, so an abandoned or refused sign-in never leaves a project worse off.
- Keys travel only in the answer's `secret` value to the engine; no response, event, audit entry or error carries them, and `AiTool.auth` names the method, never the key.

## Acceptance criteria

- [x] Strict in, tolerant out for every new schema; tests for the problem/status rule, unknown values, unknown prompt kinds and refused bodies (`capabilities/ai-tools.test.ts`).
- [x] The reference engine's behaviour, permissions, step-up, session binding, audit without secrets and chat blocking are tested (`in-memory/ai-tools.test.ts`); `engine-api` coverage thresholds hold.
- [x] The five conformance checks pass against the in-memory engine and the mock engine, skip without the capability, and fail against a fake for each broken rule (`ai-tools.test.ts`).
- [x] **Status** line above set to `done (…)`.

## Risks and open points

- The engine team's tool IDs, how long a verifying call takes, and whether Claude's `setup-token` is a method of its own (ai-tools.md, Open).
