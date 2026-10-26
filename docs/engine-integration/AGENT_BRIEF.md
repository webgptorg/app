# Agent brief: build the engine side of the Promptbook platform protocol

This file is a prompt. The engine maintainer pastes everything below the line into a coding agent that works in the engine repository. It is self-contained: it names every file the agent must read, the rules it must not break, the loop it follows and when it is done.

Before pasting, replace the two placeholders:

- `<PLATFORM_DIR>`: a read-only checkout of the repository that holds this guide and the contract packages, pinned to one commit.
- `<ENGINE_DIR>`: the engine repository (`webgptorg/promptbook`), where the agent works.

---

You are implementing the engine side of the Promptbook platform protocol in the open-source Promptbook engine at `<ENGINE_DIR>`. When you are done, the engine can replace our mock engine: it registers with the dashboard, sends signed heartbeats, keeps a tunnel to every relay, ends browser TLS itself with its own ACME certificates, puts a passkey gateway in front of everything, serves the engine API v1, and serves our signed UI bundle after verifying it. It passes the conformance suite and the platform's end-to-end tests with no change on the platform side.

## Context

- The platform (relay, dashboard, UI bundle) never sees engine content. The relay only pipes TLS bytes; the dashboard only links an engine to an account and receives numbers in heartbeats. Everything you build keeps it that way.
- The contracts are code: `@ptbk/protocol` (wire formats between engine, relay and dashboard), `@ptbk/engine-api` (the HTTP API the UI uses) and `@ptbk/conformance` (the suite that proves an engine). They live in `<PLATFORM_DIR>/packages/`. When the guide and the code disagree, the code wins.
- Our mock engine in `<PLATFORM_DIR>/apps/mock-engine/` implements every contract and is the reference implementation. Read it, port its logic where it fits, but never copy its dev-only parts (listed below).
- Until the contracts are published, the engine depends on them by path from `<PLATFORM_DIR>`: phase 0 of the plan spells out the commands. Never copy contract sources, schemas or packed tarballs into `<ENGINE_DIR>`, and ask the maintainer before you push anything that depends on them to a public branch.
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
5. **Replace the old access code, do not port it.** The engine's existing login, session cookie, API token checks, CORS handling and middleware access checks must not sit in front of the engine API or the UI. The gateway replaces them. Never port server code from the old agents server into the gateway.
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

Never skip, weaken or filter out a check to get green. A check may report `skip` only for the reasons the plan allows: a capability you do not advertise yet, or a suite the plan marks as pending.

## When you are done

The engine is done when all of these hold:

- Every `ENG-xx` row in `checklist.md` is implemented, or is marked in the plan as not required yet.
- The conformance suite passes against the engine with no failure. The only skips are `capability-not-advertised` for capabilities you chose not to ship, and checks of suites the plan still marks as pending.
- The local stack in `testing-against-the-platform.md` works with the engine in place of the mock: link it with a link code, see it online in the dashboard, open it through the relay, sign in with a passkey and chat with an agent, with no CSP violation in the browser console.
- The engine repository's tests and lint pass, and the changes are documented the way its own instructions require.

Then write a short report for the maintainer: what you built, where it lives, the check results, and every open question or contract proposal from the next section.

## When a contract looks wrong

The contracts are shared with the relay, the dashboard and the UI. A private change on your side breaks them, so:

- **Never diverge.** Do not change a wire format, add an undeclared response field, rename a path or loosen a check, even if the contract looks like a mistake.
- **Write a proposal** for the maintainer, who raises it with the platform team: what you expected, what the contract or a check does, the check ID or file and line, why it matters, and the smallest change that would fix it. Changes go in by addition (a new optional field, a `v2` next to `v1`), never by editing `v1`.
- **Keep going.** Implement the rest of the phase against the contract as it is. If you are blocked, stop that item, say so in your report, and move on to the next phase only if it does not depend on it.
- **Ambiguity is a question, not a choice.** If the guide leaves a behaviour open and the plan gives no default, ask. Do not guess on anything security-related.
