# X-07. E2E: onboarding from install command to owner passkey

- **Lane:** X · **Module:** `e2e/` · **Milestone:** M3
- **Depends on:** D-10, D-11, D-12, R-07, M-08, X-05, X-06
- **Status:** todo
- **Spec:** Pairing and identity (First setup); One address for users; What our platform can and cannot do; design: [onboarding.md](../../design/onboarding.md) (Journey 1, Time-to-value targets, Failures and edge cases)

## Goal

A browser test walks Journey 1 end to end on the compose stack: sign up, start a trial, copy the install command, link the mock engine, watch every live progress state on the dashboard, take the setup link from the engine's terminal output, register the owner passkey on the engine, and open it. It measures the onboarding targets.

## Context

X-05 proves linking with the dev login; it skips the owner setup because the mock had none. M-08 adds the setup secret and `/setup`, D-10 the live checklist, D-11 the tabs, D-12 the emails and R-07 the reachable state. This test ties them together and is the regression guard for the flow the engine team must reproduce (E-03 runs it against the real engine).

## Scope

- `e2e/tests/onboarding.spec.ts` (Playwright, virtual WebAuthn authenticators for the dashboard and the engine hostname):
  1. Sign up via the fake outbox, see the plan step, start the trial in the fake Checkout, land back on `/engines/new`.
  2. Read the command from the installer tab (the dev command), run the mock engine's `connect` with it in the stack, and assert the checklist moves through waiting, linked (the fingerprint on the page equals the one in the engine's output), online, reachable, waiting for the owner.
  3. Take the setup link from the engine's terminal output (the `setup-link` command's stdout, never the log stream), open it, register the owner passkey, see the done state; the dashboard turns ready.
  4. "Open engine" opens the engine at its hostname, signed in.
  5. The fake outbox holds exactly one "Your engine … is online" email.
- Negative paths: an expired link code (the e2e dashboard uses a 30 s lifetime) shows the expired state and the engine's refusal line; reopening the used setup link shows "This engine already has an owner"; `owner --reset` makes the dashboard show "Owner not set up" again.
- Assert the engine's log stream never contains the setup secret or the link code across the run.
- Record the time from command to setup link and from landing to ready in the test report (not as a hard limit in CI).

## Out of scope

- The real engine (E-03), proxies and NAT (X-02 covers the network paths).

## Design notes

- Reuse X-05's compose overlay and helpers; the mock runs without `MOCK_DEV_LOGIN` in this test.

## Acceptance criteria

- [ ] The test passes in the e2e suite and under `test:csp` with no CSP violation on the dashboard, the setup page or the engine UI.
- [ ] The negative paths above pass.
- [ ] The secret scan of the log stream passes.
- [ ] `bun run check` passes; the full e2e suite passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Two WebAuthn relying parties in one Playwright context: use one virtual authenticator per origin if Chromium needs it.
