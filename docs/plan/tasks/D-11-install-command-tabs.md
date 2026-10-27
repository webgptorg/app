# D-11. Install command tabs from configuration

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-03, M-08
- **Status:** in progress (feat/d-11-install-command-tabs)
- **Spec:** Pairing and identity (First setup); Moving existing deployments; Build plan (Distribution); design: [onboarding.md](../../design/onboarding.md) (Journey 1 step 3, Journey 2); guide: [installation.md](../../engine-integration/installation.md#install-paths)

## Goal

The link page offers the three install paths as tabs, each one copyable block with the same link code: the installer one-liner, Docker Compose, and "Already running Promptbook" with the exact `connect --link` one-liner. The commands come from configuration, so the engine team's final commands replace the placeholders without a code change.

## Context

D-03 renders one `INSTALL_COMMAND` template with a `{linkCode}` placeholder; outside dev it is still `<engine-install-command> {linkCode}`. Decided 2026-10-26 (E-05): Docker first (a signed multi-arch image, a verifying installer, a published Compose file; other forms may come later); connecting a running engine is CLI-only in v0, but the dashboard shows the exact one-liner with a copy button so it is still one paste. The Compose tab is three commands (installation.md, path 2).

## Scope

- Configuration `INSTALL_COMMANDS`: an ordered list of `{ id, labelKey, template, docsAnchor }`, at least `installer`, `compose` and `connect`. Each template contains `{linkCode}` exactly once; templates may span lines. Validated at startup like `INSTALL_COMMAND`, which it replaces (keep reading the old variable for one release, then remove it).
- `POST /api/engines/link-codes` returns `installCommands: [{ id, command }]` instead of `installCommand`; the typed contract changes with it.
- `/engines/new`: `@ptbk/ui` tabs (keyboard accessible), the first selected; each tab has its copy button ("Copy install command"), the one-line requirement note and a "Requirements and proxies" link to the public guide; the "Already running Promptbook" tab carries the move-from-the-predecessor line from onboarding.md Journey 2a.
- Dev: `installer` renders `bun run dev:link {linkCode}` (X-06); `connect` renders the mock engine's `connect --link {linkCode}` from M-08 inside the stack. Staging and production keep placeholders until the engine team publishes the real commands (an Apply step).
- Strings in `en` and `cs`.

## Out of scope

- The live progress and the plan step (D-10). The installer itself (engine team).

## Design notes

- The link code is substituted server-side once and shown once, as today; switching tabs never asks the API again.
- A command is text, never HTML: render in a code block, copy with the Clipboard API.

## Acceptance criteria

- [ ] Config tests: a template without `{linkCode}`, with it twice, an unknown `id` or an empty list fails startup.
- [ ] Workers test: the response carries one command per configured tab, each containing the code once.
- [ ] Client tests: tabs render in order, keyboard switching works, each copy button copies its own command.
- [ ] Both locales complete; axe clean at 360 px.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The real installer URL, image name and its hash in the command come from the engine team; until then staging shows placeholders.
