# E-04. Engine implementation kit for coding agents

- **Lane:** Engine integration · **Module:** `docs/engine-integration/` · **Milestone:** M5
- **Depends on:** E-01, C-05, X-06
- **Status:** in progress (docs/e-04-engine-agent-kit)
- **Spec:** Interfaces (draft) 1–6, Build plan; ADRs: [0002](../../adr/0002-public-private-split.md), [0004](../../adr/0004-mock-engine-and-conformance.md), [0014](../../adr/0014-cryptography.md)

## Goal

The engine maintainer can hand `docs/engine-integration/` to a coding agent and get the engine side of the protocol built in one pass: an ordered build plan, a paste-in agent brief, and a guide to testing the real engine against our stack without our credentials. The existing guide matches the code on `main`.

## Context

E-01 wrote the guide for humans reading topic by topic. Since then the conformance suite (C-05), the mock engine (M-01 to M-07) and the local dev stack (X-06) have merged, and the guide has drifted: its README still says conformance has no checks and that M-03 has not started. An agent that trusts stale text builds against guesses. The engine lives in `webgptorg/promptbook` (`apps/agents-server`), a Next.js app whose old server-side auth must not be ported (AGENTS.md, Predecessor code), so the plan must say what to replace and what may stay.

The conformance CLI's `--engine-cmd` mode and the registration, heartbeat, tunnel and UI loader suites are being built in parallel (C-08, C-09, C-10). This task writes against their briefs and marks what has not merged as pending, with the task ID. A follow-up PR (`Refs: E-04`) removes the pending marks once they merge.

The folder moves public with the contracts (E-02), so the same rules as E-01 apply: nothing private, no relay internals beyond the tunnel protocol, no dashboard internals beyond the engine-facing endpoints, no infra, no secrets.

## Scope

- Drift audit of every file in `docs/engine-integration/` against `main`: contract exports and their names, `ENGINE_API_VERSION` and other versions, the environment variables the mock engine reads, task and endpoint statuses. Fix what is wrong. A real contract question goes into the README's open points.
- `implementation-plan.md`: phases from setup to a full e2e run. Each phase names what to read, what to build (links into the topic files and to contract exports, no schema copies), the conformance suites and check IDs that must pass, the exact command, the mock engine files to study, and common pitfalls. Codebase mapping onto `agents-server` is phrased as suggestions.
- `AGENT_BRIEF.md`: a self-contained prompt to paste into a coding agent: context, the security rules that apply to the engine, the loop "implement a phase, run conformance, fix until green", the definition of done, and what to do when a contract looks wrong.
- `testing-against-the-platform.md`: the conformance CLI (including `--engine-cmd`), the local dev stack with the mock engine swapped for the real one, E-03's full e2e, and a troubleshooting table (symptom, likely cause, the check that catches it).
- README reading order; `checklist.md` and `conformance.md` only where the new files need it. Check-ID rows belong to the suites' own tasks.

## Out of scope

- The onboarding UX spec and the operator installation guide (E-05).
- New conformance checks or CLI modes (C-08, C-09, C-10). Engine code. Anything in `webgptorg/promptbook`.

## Design notes

- Link exports by name and files by path; never paste schemas.
- Every command in the kit is one that works on `main` today, or is marked pending with its task ID.
- House style: plain English, short sentences, normative must and should, Prettier-clean.

## Acceptance criteria

- [ ] The README no longer contradicts `main` (conformance checks, task statuses, versions, environment variables); every fix is listed in the PR.
- [ ] `implementation-plan.md` covers every phase from setup to the full e2e run, and each phase names its conformance checks and the command that runs them.
- [ ] `AGENT_BRIEF.md` can be pasted into an agent as is and links only to files in this folder or to contract code.
- [ ] `testing-against-the-platform.md` covers the conformance CLI, the local dev stack and E-03, with a troubleshooting table; parts that have not merged are marked pending with their task ID.
- [ ] The guide's link and private-content checks pass.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The suites and the `--engine-cmd` mode are moving while this is written; the follow-up PR reconciles the kit with what merged.
- Gaps where the contracts are too vague for an agent to implement without guessing are reported to a human as questions, not decided here.
