# 0016. Engine capabilities and a typed, extensible activity model

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

Besides chat, the UI must show what agents do: runs, files and knowledge, triggers and schedules, integrations and tools. What the real engine will expose is still being decided by the engine team; the predecessor already models most of it (a durable job per chat turn with status, progress, tool calls, usage and run reports with git changes; files with purposes; planned messages with cron; a secrets wallet; MCP and calendar integrations). New structures will keep coming, and the UI must not need a refactor for each.

## Decision

- **Capability discovery.** `GET /engine` returns `capabilities: [{ id, version }]`, e.g. `runs@1`, `files@1`, `triggers@1`, `integrations@1`. Versions follow [ADR 0010](0010-protocol-design-principles.md): additive within a version, a new version next to the old.
- **One contract module per capability** in `packages/engine-api` (`src/capabilities/runs.ts` …): its zod schemas, routes (each with its permission), and event types. The core contract (agents, chats, members, secrets, security, audit) stays as it is.
- **Activity is a discriminated union** `{ kind, v, id, at, agentId, … }` (`run.started`, `run.completed`, `file.created`, `trigger.fired` …), delivered through the existing `/events` stream and an activity feed endpoint. Unknown kinds or versions are ignored by logic and rendered by a generic fallback card, never an error.
- **Normalised models** (v1, modelled on what the predecessor has):
  - _Run_: one unit of agent work, whatever started it (`source: web | api | email | schedule | member | goal | webhook`), with `status: queued | running | completed | failed | cancelled`, timestamps, steps (progress items), tool calls (name, state, duration), usage (tokens, duration, cost when known), error summary, and outputs (messages, files, project changes with commit and changed files). Cancel and retry are actions with permissions.
  - _File_: `purpose: knowledge | attachment | output | upload`, scan status, size, type, owning agent, versions where the engine has them.
  - _Trigger_: `kind: email | schedule | webhook`, lifecycle (`active | paused | ended | failed`), schedule `once | interval | cron` with next and last fire, fire history linked to runs.
  - _Integration_: `kind` (MCP server, calendar, repository, …), status, scopes, the secrets it references by name (never values), and its activity.
- **UI feature modules** mirror the contract modules: each registers its sections (in the agent detail and the main navigation), list columns, detail views, activity renderers and required capability plus permission in a typed registry. The shell shows a feature only when the engine advertises its capability and the member has its permission.
- The mock engine implements every capability with seeded data, so the UI is complete before the real engine; the conformance suite tests each advertised capability.

## Consequences

- A new structure is one contract module plus one UI module; nothing else changes.
- The real engine can ship capabilities one by one; the UI adapts automatically.
- The engine team gets a precise, typed target per capability.
