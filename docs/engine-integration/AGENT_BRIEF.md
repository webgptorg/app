# Agent brief: build the engine side of the Promptbook platform protocol

This file is a prompt. The engine maintainer pastes everything below the line into a coding agent that works in the engine repository. It is self-contained: it names every file the agent must read, the rules it must not break, the loop it follows and when it is done.

Before pasting, replace the two placeholders:

- `<PLATFORM_DIR>`: a read-only checkout of the repository that holds this guide and the contract packages, pinned to one commit.
- `<ENGINE_DIR>`: the engine repository (`webgptorg/promptbook`), where the agent works.

---

You are implementing the engine side of the Promptbook platform protocol in the open-source Promptbook engine at `<ENGINE_DIR>`. When you are done, the engine can replace our mock engine: it registers with the dashboard, sends signed heartbeats, keeps a tunnel to every relay, ends browser TLS itself with its own ACME certificates, puts a passkey gateway in front of everything, serves the engine API v1, and serves our signed UI bundle after verifying it. It passes the conformance suite and the platform's end-to-end tests with no change on the platform side.

## What changed

Until the contracts freeze at publication (task E-02), the platform changes them in place, without a `v2` next to `v1`, and records every change here, newest first. At the start of every session, read the entries dated after your last session and redo what they list before you continue with the plan.

Each entry has this shape. Platform authors: add yours at the top of the list, one entry per change, and keep it short; link the doc that explains the change instead of repeating it.

```md
### YYYY-MM-DD: <area>

- **Changed:** what is different in the contract, conformance or docs, with links.
- **Redo:** what the engine's agent must change, re-run or drop; "nothing" if it is inert.
```

### 2026-11-05: Engine-driven onboarding

- **Changed:** new capability `onboarding@1`: `GET /onboarding`, `POST /onboarding/answer`, `POST /onboarding/defer`. Your initializer presents its prompts (text or intent, choice, confirm, upload through `files@1`, harness login with URL, code and status) and the UI only renders and answers them, like your desktop client's prompt transport. New problem `onboarding-prompt-stale`, new checks `engine-api.onboarding.state` and `engine-api.onboarding.refusals` (ENG-115). See [engine-api.md](engine-api.md#onboarding).
- **Redo:** expose the pending App-started `ptbk init` through these routes: map each prompt to a kind, keep choice values and drafts in the engine, report the harness adapter's real sign-in (Codex `--device-auth` URL and code, Claude URL plus returned code) and its readiness, and treat `defer` as "set up through the built-in agents". Never log a code or send it as chat; leave Wallet setup out.

### 2026-11-05: Activity follows capabilities

- **Changed:** `GET /activity` lists no item of a capability the engine does not advertise (`ACTIVITY_CAPABILITIES`). See [engine-api.md](engine-api.md#capabilities).
- **Redo:** nothing if you only write activity for what you serve; otherwise filter it.

### 2026-11-05: Agent origin and the built-in agents

- **Changed:** every `Agent` has `origin`: `content`, `core` (Chatter, Adam, Tasker, Router, Fixer, Teacher) or `system` (Expert), and `GET /agents` takes `origin=` with one value or a comma-separated set. `profile.description` is the one-line role the UI shows for built-in agents. Changing, deleting, restoring or saving the source of a `system` agent is 409 `agent-engine-owned` (new problem code). New check `engine-api.agents.origin`. See [engine-api.md](engine-api.md#agent-origin).
- **Redo:** send `origin` on every agent from the Book's definition ownership (your `ChatAgentChoice` groups map onto it), list Expert as `system` and refuse changes to it with `agent-engine-owned`, filter by `origin`, and make each core Book's description its role.

### 2026-11-05: Tasks

- **Changed:** a new read-only capability, `tasks@1` ([engine-api.md](engine-api.md#capabilities), [tasks.ts](../../packages/engine-api/src/capabilities/tasks.ts)): `GET /tasks`, `GET /tasks/{taskId}` and `GET /tasks/{taskId}/occurrences` report your task inventory as Reborn models it (ordinary and engine-owned tasks in one list, your readiness kinds as `state`, `TASK PARENT`, `TASK DEPENDS ON`, `TASK ORIGIN`, the directed `LINK` graph, recurrence, reopen cycles and retries as occurrences), plus the `task.changed` event and the `tasks.read` permission. `Run` gained `taskId` and `occurrenceId` (both `null` for work outside a task, such as a chat reply), and `GET /runs` a `taskId` filter. Conformance adds `engine-api.tasks.*` (ENG-111).
- **Redo:** serve the three routes from your task views (`taskInventory`, task detail, the runs of each definition) with `Task.id` an opaque ID you derive from the normalized Book name or the engine-owned definition, and advertise `tasks@1` once they pass `--suite engine-api`. Send `taskId` and `occurrenceId` on every run. Report `allowedActions: []` until we agree which task-control operations the App may call; changes stay in chat.

### 2026-11-05: Features Reborn does not have are capabilities

- **Changed:** five former core features are capabilities, so an engine without them leaves them out of `GET /engine` and answers their routes with 404 `capability-not-supported`: `members@1` (invites, role changes, removals; member reads and `/me` stay core), `api-tokens@1`, `audit@1`, `book-editor@1` (saving and validating Book source, revisions) and `agent-management@1` (visibility, folder, restore). Their conformance checks skip when not advertised. The mock starts in a `reborn` profile that advertises only what Reborn has; `MOCK_PROFILE=full` shows everything. See [engine-api.md](engine-api.md#capabilities).
- **Redo:** advertise only what you serve. Reborn has none of the five yet: leave them out and answer their routes with 404 `capability-not-supported`.

### 2026-11-05: Live audio, video and the browser tab (design only)

- **Changed:** engine API 1.14.0 reserves `live-audio@1`, `live-video@1` and `browser-tab@1` in `RESERVED_CAPABILITIES`, with two `draft` routes (`openLiveAudioSession`, `openBrowserTabSession`), the `browser.control` permission and a channel path; conformance adds `engine-api.live.reserved` and two registered stubs. The tunnel protocol is unchanged. Design: `<PLATFORM_DIR>/docs/engine-integration/live-sessions.md`, ADR 0019.
- **Redo:** nothing to build. Do not advertise these capabilities; let the two routes answer 404 `capability-not-supported` like any unadvertised capability; give `browser.control` to owners only. Send the open questions at the end of the design to the maintainer.

### 2026-11-05: Change log

- **Changed:** contract changes before E-02 are made in place and listed here. The engine API is being aligned with the Reborn engine (`specs/app/integration.md`); expect several entries.
- **Redo:** nothing yet. Read this section first from now on.

## Context

- The platform (relay, dashboard, UI bundle) never sees engine content. The relay only pipes TLS bytes; the dashboard only links an engine to an account and receives numbers in heartbeats. Everything you build keeps it that way.
- The contracts are code: `@ptbk/protocol` (wire formats between engine, relay and dashboard), `@ptbk/engine-api` (the HTTP API the UI uses) and `@ptbk/conformance` (the suite that proves an engine). They live in `<PLATFORM_DIR>/packages/`. When the guide and the code disagree, the code wins.
- Our mock engine in `<PLATFORM_DIR>/apps/mock-engine/` implements every contract and is the reference implementation. Read it, port its logic where it fits, but never copy its dev-only parts (listed below).
- The engine consumes the contracts from `<PLATFORM_DIR>` by path. That is the supported way, not a workaround: phase 0 of the plan spells out the commands. Never copy contract sources, schemas or packed tarballs into `<ENGINE_DIR>`; the checkout is the one source. Whether and when this work goes public is the maintainer's decision; follow his instructions for branches and pushes.
- Our test stacks are in `<PLATFORM_DIR>/e2e/` and our conformance CLI is built from `<PLATFORM_DIR>/packages/conformance/`. You run them; you never change them.
- `<PLATFORM_DIR>` is read-only for you. Never edit, commit to, push to or open issues or pull requests in it or in any repository other than `<ENGINE_DIR>`. Contract problems go to the maintainer (see "When a contract looks wrong").

## Read first, in this order

1. `<PLATFORM_DIR>/docs/engine-integration/README.md`: the system, the glossary and the open points. Do not build against an open point; follow what the plan says for it.
2. `<PLATFORM_DIR>/docs/engine-integration/implementation-plan.md`: the phases you will work through. This is your task list.
3. `<PLATFORM_DIR>/docs/engine-integration/cryptography.md`: the encodings every signature uses.
4. `<PLATFORM_DIR>/docs/engine-integration/testing-against-the-platform.md`: how to run the checks.
5. `<PLATFORM_DIR>/apps/mock-engine/README.md` and `<PLATFORM_DIR>/packages/conformance/README.md`: what the reference implementation does, and what every check does to an engine.
6. `<PLATFORM_DIR>/docs/engine-integration/checklist.md`: every requirement with its ID (`ENG-xx`). Track your progress by these IDs.
7. The engine repository's own agent instructions (`<ENGINE_DIR>/AGENTS.md` and whatever it includes). Follow them for code style, changelog and tests, unless they conflict with a rule below; then the rule below wins and you tell the maintainer.

Each phase in the plan names the topic file and the sections to read for it. Read them when you start that phase, not all at once.

## Rules you must never break

These are the zero-trust guarantees on the engine side. A change that would weaken one is not yours to make: stop and ask the maintainer.

1. **Strict in, tolerant out.** Parse every input strictly with the contract's schemas: unknown fields, repeated query parameters and out-of-range values are refused. Read what the dashboard and relays send with the contract's tolerant readers (`TolerantRegisterEngineResponse`, `TolerantProblemDetails`, `parseRelayMessage`). Send responses with no field the contract does not declare.
2. **Use the contract, never a copy of it.** Import the exports the guide names. Never re-type a schema, re-implement `signingInput`, signature verification, the frame codec or `verifyRelease`, or hard-code a path or constant the contract exports. If you cannot import a package in your environment, stop and ask.
3. **No dynamic code.** No `eval`, `new Function`, `vm` or string timers in anything you add, and nothing you add may call existing code that does. Add a lint rule for it in the new code.
4. **The gateway is in front of everything.** In tunnel mode the gateway is the only thing that listens. The app server listens on 127.0.0.1 only. Anonymous requests reach only the sign-in page, the WebAuthn endpoints, the setup page and agents the owner marked public. Authorisation runs in one policy module, deny by default.
5. **Replace the old access code, do not port it.** The engine's existing login, session cookie, API token checks, CORS handling and middleware access checks must not sit in front of the engine API or the UI. The gateway replaces them. Never port server code from the old agents server into the gateway. If you can read `<PLATFORM_DIR>/docs/security/agents-server-review.md`, read it before phase 6: it lists that code file by file with what replaces it. It is private, so never quote it in the engine repository, a commit message or a public issue.
6. **The engine origin serves only the gateway pages, the engine API and our verified UI bundle.** No other frontend, no inline scripts or styles, no custom JavaScript, no external origins. Send `ENGINE_UI_CSP` from `@ptbk/engine-api` byte for byte, with the other headers in `gateway.md`. Model output never becomes executable.
7. **Key handling.** The engine key is created and stored exactly as `identity-and-registration.md` says (0700 directory, `O_EXCL`, 0600, `fsync`, ownership checks, non-extractable at runtime) and is used only through `signingInput` contexts. The ACME account key and the TLS keys are separate keys. Never compare signature bytes; only verify. Random values come only from a CSPRNG. Secrets are compared as digests in constant time.
8. **Never log content or credentials.** Logs, errors, audit `details` and test snapshots never contain keys, signatures, the link code, the setup secret, session tokens, cookies, API tokens, secret values, prompts, messages, file content or heartbeat bodies. Log codes, statuses and IDs.
9. **Secrets are write-only.** No response, stream, log or error ever returns a secret value.
10. **Nothing leaves the engine unless it is on the list.** The engine contacts only the relays, the dashboard API, the release store and destinations the owner configured. No telemetry or error reporting is on by default in tunnel mode.
11. **Test hooks stay out of production.** Never copy the mock engine's control listener (`/__mock/`), its dev login, its fault injection or its fake provenance verifier. Any test-only switch you need is off by default, refused when `NODE_ENV=production`, never reachable through the tunnel, and agreed with the maintainer first.

## The loop

Work through `implementation-plan.md` one phase at a time, in order. For each phase:

1. Read what the phase lists. Study the mock engine files it names.
2. Write the tests first: the golden vectors the phase names, then the reject paths (forged signature, replay, downgrade, wrong relay, missing permission), then the happy path.
3. Implement it in the place the plan suggests, or a better one in this repository; say why if you deviate.
4. Run the phase's commands. A check that fails is a bug in the engine until proven otherwise: read its detail, fix the engine, run it again. Repeat until every check the phase names passes.
5. Run the engine repository's own tests and lint.
6. Commit with a message that names the phase and the `ENG-xx` IDs it completes. Update your copy of the checklist.

Never skip, weaken or filter out a check to get green. A check may report `skip` only for the reasons the plan allows: a capability you do not advertise yet, or a check that needs a later phase's work.

## Not yet: live audio, video and the browser tab

Full-duplex voice in a chat, later video, and the owner driving one engine browser tab to sign in to a site are designed but not buildable yet: read `<PLATFORM_DIR>/docs/engine-integration/live-sessions.md` once, for its open questions, and build none of it. They ride inside the browser's TLS to the engine as a WebSocket on the engine origin, so nothing in the tunnel, relay or registration changes for them.

## When you are done

The engine is done when all of these hold. Run them on a **conformance build** of the engine (the build that ships `conformance-session` and may read `PTBK_CONFORMANCE_TRUST_FILE`; a release build refuses both).

1. **Every conformance suite passes**, in one command that starts the engine itself and plays the dashboard, the relays and the release store, and reaches the engine API through its relay:

   ```sh
   node "<PLATFORM_DIR>/packages/conformance/dist/ptbk-conformance.js" \
     --engine-cmd "<start command of your conformance build>" --engine-cwd "<ENGINE_DIR>/<package>" \
     --engine-session-cmd "<your engine> conformance-session" \
     --engine-ca-file "{dataDir}/<path of its development CA certificate>" \
     --suite engine-api,registration,heartbeat,tunnel,ui-loader \
     --report junit --out conformance-report.xml
   ```

   Run it without any heartbeat interval override, so `heartbeat.cadence.interval` proves the production 60 s. It exits 0 only when no check failed.

2. **The local dev stack works** with your engine in place of the mock (`testing-against-the-platform.md`, section "(b) The local dev stack"). Link it with a link code, see it online in the dashboard, open it through the relay and sign in with a passkey, with no CSP violation in the browser console. The UI part of this check waits for the platform's task E-03, which re-signs the stack's UI releases for a conformance build.
3. **No skips except these:** `capability-not-advertised` for capabilities you chose not to ship, and `engine-api.cross-member.private-resources`, which needs a target module (`testing-against-the-platform.md`, section "Against a running engine").
4. **Every `ENG-xx` row** in `checklist.md` is implemented, or is marked in the plan as not required yet.
5. **The engine repository's tests and lint pass**, and the changes are documented the way its own instructions require.

Then write a short report for the maintainer: what you built, where it lives, the conformance summary (`passed`, `failed`, `skipped`), the dev stack result, and every open question or contract proposal from the next section.

## When a contract looks wrong

The contracts are shared with the relay, the dashboard and the UI. A private change on your side breaks them, so:

- **Never diverge.** Do not change a wire format, add an undeclared response field, rename a path or loosen a check, even if the contract looks like a mistake.
- **Write a proposal** for the maintainer, who raises it with the platform team: what you expected, what the contract or a check does, the check ID or file and line, why it matters, and the smallest change that would fix it. Until E-02 the platform makes the change in place and lists it under "What changed"; after E-02, changes go in by addition (a new optional field, a `v2` next to `v1`), never by editing `v1`.
- **Keep going.** Implement the rest of the phase against the contract as it is. If you are blocked, stop that item, say so in your report, and move on to the next phase only if it does not depend on it.
- **Ambiguity is a question, not a choice.** If the guide leaves a behaviour open and the plan gives no default, ask. Do not guess on anything security-related.
