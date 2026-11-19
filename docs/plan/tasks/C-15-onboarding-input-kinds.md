# C-15. Onboarding input kinds for setup in the browser after pairing

- **Lane:** C · **Module:** `packages/engine-api`, `packages/protocol`, `packages/conformance` · **Milestone:** M5
- **Depends on:** —
- **Status:** done (#336)
- **Spec:** Pairing and identity; ADRs: [0010](../../adr/0010-protocol-design-principles.md), [0016](../../adr/0016-engine-capabilities.md)

## Goal

A paired engine that has no project yet can run its whole setup through the signed UI. The owner never goes back to the terminal after pasting the install command. `onboarding@1` carries every input the engine's App flow needs, as a fixed set of kinds that the UI ships first and the engine combines however it likes.

## Context

Reborn already pairs before init (`ptbk init --prepare-only --link`, `specs/app/onboarding.md` on `reborn/2026-10`) and drives `onboarding@1`. But two things bypass the contract. API-key entry is a private `api-key` action on its own `/_ptbk/harness-terminal` page. The native terminal is reached through a `confirm` prompt whose hint names that path. Pavol will simplify his initializer later, so the UI must not depend on the steps, only on the kinds. Contract changes go in place, with a dated AGENT_BRIEF entry, until E-02.

Decisions (Seb, 2026-11-19):

- Cover the App flow plus the sign-in gaps.
- For Claude Code, prefer the return code, with the engine's own terminal page as a linked fallback. No terminal in our UI for now.
- Our signed UI is the first page on a pending engine.
- The dashboard shows whether setup is finished.
- A step list while the engine works.
- An unknown kind reads as unsupported (a safety net only).

## Scope

- `onboarding.ts` (done in the first commit):
  - a `secret` prompt and answer;
  - `details` and `alternatives` on every prompt, with `{ action: alternative, alternativeId }`;
  - `activity` and `canDefer` on the state;
  - problem `onboarding-not-deferrable`;
  - `OnboardingStateReader`, which reads unknown kinds as `unsupported`.

  New fields default (`[]`, `true`), so an engine from before this change still parses.

- `heartbeat.ts` (done in the first commit): optional `setup: pending | done`.
- The in-memory reference engine (`packages/engine-api/src/in-memory/onboarding.ts`) follows Reborn's App flow and uses every kind:
  - intent (text with attachments);
  - harnesses (multiple choice);
  - `working` with `activity` (install and check per harness; one may fail with a reason while another passes);
  - sign-in:
    - Codex: `device-code`, with alternatives "Use an API key instead" (leads to a `secret` prompt) and "Sign in in a terminal instead" (an `href` link to `/_ptbk/harness-terminal`);
    - Claude Code: `return-code`;
  - title and folder (text);
  - review (`confirm` with `details`);
  - `working` while the project is created, then done.

  A seed for an engine with no project yet answers `canDefer: false` until done. Levers for tests stay deterministic: device sign-in, a failing harness check, a refused key.

- Conformance:
  - extend `engine-api.onboarding.state` (activity and details invariants, `canDefer` consistent with `defer`);
  - extend `engine-api.onboarding.refusals` (an alternative the prompt does not offer is 400; `defer` while `canDefer` is false is 409 `onboarding-not-deferrable`);
  - still never answer a prompt for real.
- Docs (done in the first commit): [engine-api.md](../../engine-integration/engine-api.md#onboarding), [heartbeat.md](../../engine-integration/heartbeat.md), the AGENT_BRIEF entry of 2026-11-19.

## Out of scope

- The mock engine's pending mode and heartbeat `setup` (M-10), the UI (U-20), the dashboard (D-36).
- A terminal inside our UI.
- Wallet setup, Git sync, traces and browser profile as steps: the engine can already ask them with these kinds.

## Acceptance criteria

- [x] The reference engine walks the whole flow above in a test, including back, a refused secret (whose value appears nowhere in the state), a failed and a passing harness in `activity`, and both alternatives.
- [x] `OnboardingStateReader` reads an unknown kind as `unsupported` and still rejects a known kind with a bad field.
- [x] Conformance checks above pass against the in-memory engine and fail against a fake that breaks each rule.
- [x] `engine-api` and `protocol` coverage thresholds hold; `bun run check` passes.
- [x] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- A secret must never reach the in-memory engine's audit log, the `error` text or the draft. Test it.
