# U-20. Setup in the browser: every onboarding input kind

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M5
- **Depends on:** C-15
- **Status:** in progress (feat/u-20-setup-in-the-browser)
- **Spec:** Security hardening; ADRs: [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md)
- **Design:** [ui.md](../../design/ui.md), [onboarding.md](../../design/onboarding.md)

## Goal

The engine UI renders every `onboarding@1` kind and field from C-15. An owner whose engine has just paired finishes the whole setup in the browser, whatever steps the engine asks and in whatever order.

## Context

The UI already renders `text`, `choice`, `confirm`, `upload` and `harness-login` (`src/features/onboarding/`) and redirects home to `/onboarding` while setup is pending. The engine owns the steps; the UI must never branch on a step's title or position, only on kinds and fields.

## Scope

- `secret`:
  - a masked field (`type=password`, `autocomplete=off`, no spellcheck), with `label`, `placeholder` and a `helpUrl` link;
  - the value is cleared after submit and on unmount;
  - it never sits in the query cache, a mutation's retained variables, a URL, a log or an error toast;
  - a refused secret shows `error` with an empty field.
- `details`: a quiet label and value list under the question; on a final `confirm` it reads as the review.
- `alternatives`:
  - without `href`: a secondary action that sends `{ action: alternative }`;
  - with `href`: a link opening in a new tab (`rel=noopener`), with copy saying to come back here afterwards.
- `activity`: a step list while `working` (running, done, failed with its reason, skipped), and kept above the next prompt when it has a failure.
- `canDefer: false`: no "Skip for now"; a quiet line that answers are saved and the page can be closed. A pending engine may advertise only `onboarding@1` and `files@1`: the shell shows only setup, no navigation into empty pages, and reopening the engine lands back on the current prompt.
- `unsupported` (an unknown kind): its title and question, "This step needs a newer version of the app", the host command `ptbk onboarding`, and keep polling.
- en and cs copy; component tests per kind and field; the CSP test still passes (no inline styles).

## Out of scope

- A terminal in our UI; dashboard (D-36); mock-engine pending mode (M-10).

## Acceptance criteria

- [ ] Tests show each kind and field rendering and answering, including a refused secret and both alternative types.
- [ ] Tests show the secret value is absent from the query cache and the DOM after submit.
- [ ] Screenshots of each new state (en) are in the PR.
- [ ] `bun run check` and `test:csp` pass.
- [ ] **Status** line above set to `done (#<PR>)`.
