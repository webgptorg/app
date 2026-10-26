# M-08. Mock engine onboarding: setup secret, setup page, operator commands and reference gateway pages

- **Lane:** Mock engine · **Module:** `apps/mock-engine`, new `packages/gateway-pages` (see Context) · **Milestone:** M3
- **Depends on:** C-11, M-04, M-05, M-06
- **Status:** in progress (feat/m-08-setup-link)
- **Spec:** Pairing and identity (First setup, Devices, members and recovery); Operations (Break-glass local login); Security hardening 1; Interfaces (draft) 1 and 4; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0014](../../adr/0014-cryptography.md); design: [onboarding.md](../../design/onboarding.md); guide: [installation.md](../../engine-integration/installation.md), [gateway.md](../../engine-integration/gateway.md)

## Goal

The mock engine onboards like the real engine must: it prints the first-start output contract, creates a one-time setup secret, prints the setup link only to an interactive terminal, serves an open `/setup` page where the owner registers a passkey, and offers `connect`, `setup-link`, `owner --reset` and `status`. Its setup and sign-in pages are portable, CSP-safe, MIT reference pages the engine team may copy, styled with a published MIT stylesheet of our design tokens.

## Context

Today the mock has no setup secret, no `/setup` and no WebAuthn; it signs in with a development-only member picker (`MOCK_DEV_LOGIN`). Onboarding (E-05) specifies the engine side, and the dashboard's live progress (D-10) and the onboarding e2e (X-07) need an engine that behaves that way.

Decided 2026-10-26 (E-05, decision 8): we publish a small MIT stylesheet with the design tokens, and the mock's `/setup` and sign-in pages are written as portable reference pages, so the first screen an owner sees matches our UI. The engine team owns and reviews whatever it ships. `apps/mock-engine` is UNLICENSED, so the pages and the stylesheet live in a new MIT package `packages/gateway-pages` that moves public with the contracts (E-02). It imports nothing from `@ptbk/*` and nothing private; it is static files plus one small browser script. This task touches two modules for that reason, and adds the package's boundary rule to `eslint.config.js` (a minimal root change).

## Scope

- **Setup secret** (installation.md, "The setup link"): created while no member has a passkey, 128 bits from `Random`, base64url, stored only as a SHA-256 in `PTBK_DATA_DIR`, single use, 30 minutes; replaced by every `setup-link`; rejected after setup completes; wrong and expired answer the same; `/setup` rate-limited per client IP; setup audited (`passkey.*`, client IP from `OPEN`).
- **WebAuthn** with `@simplewebauthn/server` and `@simplewebauthn/browser` (catalog versions), relying-party ID = the request's engine hostname. Registration on `/setup` creates the owner member; sign-in on `SIGN_IN_PATH` uses usernameless passkeys. The dev login stays behind `MOCK_DEV_LOGIN` for tests and the local stack, and is still refused with `NODE_ENV=production`.
- **`packages/gateway-pages`** (MIT): `setup.html`, `sign-in.html`, `step-up.html`, `gateway.css` and `gateway.js`. No inline script or style, valid under `ENGINE_UI_CSP` and Trusted Types (no `innerHTML`), every state from onboarding.md step 6 with its copy (English and Czech, chosen from `Accept-Language`, as static strings in the page), the engine ID, address and fingerprint shown before the prompt, the fragment read once and removed with `history.replaceState`. `gateway.css` carries the design tokens' values as CSS custom properties (light and dark), and a test in the package compares them to `packages/ui`'s token source by reading the file (no import), so they cannot drift.
- **CLI** (`src/main.ts`): `connect --link <code>` (key if missing, register, then run; `register` stays as an alias), `setup-link [--no-wait] [--json]`, `owner --reset` (typed confirmation of the first 8 characters of the engine ID, or `--yes` for tests), `status [--json]`. They reach the running engine through a local control channel inside `PTBK_DATA_DIR` (a 0600 Unix socket), never over the network. Exit codes as in installation.md.
- **First-start output** (installation.md, "First-start output"): the log stream gains the owner state ("No owner yet. Run … setup-link") and a ready event; the human progress lines are written when stdout is a TTY. The fingerprint comes from C-11's `deriveEngineFingerprint`. The setup secret never reaches the log stream (a test scans every log line of a full onboarding run).
- **Heartbeat:** `members` counts members with at least one passkey (0 until the owner's first one, 0 again after `owner --reset`); the first beat goes out right after registration and the first tunnel (installation.md, "What the dashboard reads").
- **Registration fixes found in E-05:**
  - Map `not-entitled` like `engine-limit`, and `rate-limited` (429) as retryable, using C-11's codes.
  - On `unavailable` or `rate-limited`, retry with backoff while the link code can still be valid (30 minutes), instead of exiting with code 1.
  - `src/testing/fake-dashboard.ts` answers `invalid-link-code` with 401, as the dashboard does, not 400.
- Docs: `apps/mock-engine/README.md`, `docs/engine-integration/mock-engine.md` and the reference-implementation lines in installation.md and checklist.md (ENG-102 to ENG-108).

## Out of scope

- `import`, `custom-domain`, `reset --identity`, `login --local` and `doctor` (installation.md lists them for the real engine; the mock adds them only when a test needs them). The installer script and the Docker image (engine team). Dashboard changes (D-10, D-11).

## Design notes

- Ports: `SetupSecretStore`, `PasskeyStore`, `ControlChannel`; in-memory adapters for tests. Constant-time comparison of digests (ADR 0014).
- The setup page and the sign-in page are served by the gateway outside the UI bundle and must keep working when no UI bundle is installed (M-05's plain page).
- The reference pages are meant to be copied: no build step, no framework, no dependency besides `@simplewebauthn/browser` (vendored as a pinned, hashed file).

## Acceptance criteria

- [ ] Tests for the secret's lifetime, single use, replacement by `setup-link`, rejection after setup, equal answers for wrong and expired, and the rate limit.
- [ ] A Playwright test with a virtual authenticator (in the mock's own tests or e2e) registers the owner through `/setup#<secret>` and signs in again through the sign-in page, under `ENGINE_UI_CSP` with no CSP violation.
- [ ] `owner --reset` revokes every passkey and session, keeps the seeded data, and prints a new setup link; `members` in the next heartbeat is 0.
- [ ] No log line of a full onboarding run contains the setup secret, the link code or a key (test).
- [ ] `fake-dashboard.ts` answers 401 for `invalid-link-code`; `not-entitled`, `rate-limited` and `unavailable` follow the mapping above (tests).
- [ ] `packages/gateway-pages` is MIT, imports nothing from `@ptbk/*`, and its token test passes.
- [ ] `bun run check` passes; the e2e suite still passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The engine team may choose another page structure; the reference pages are a starting point, not a contract.
- WebAuthn in the local stack needs the dev CA trusted (X-06), as for the dashboard.
