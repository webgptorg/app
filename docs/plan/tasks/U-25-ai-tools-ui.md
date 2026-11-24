# U-25. AI tools in the engine UI: Settings page, chat error and Home notice

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M5
- **Depends on:** C-18, U-20
- **Status:** done (pushed to main)
- **Design:** [ui.md](../../design/ui.md), [ai-tools.md](../../engine-integration/ai-tools.md)

## Goal

Owners fix the project's AI tools from the browser: see which work, check one now, sign one in again or switch it to an API key, sign one out. A chat reply that failed because a tool needs signing in offers "Sign in again", and Home says so quietly.

## Scope

- Feature `ai-tools` (`ai-tools@1` and `ai-tools.read`): a command palette entry, Home's attention line ("1 AI tool needs signing in", danger tone, Review), event sync on `ai-tool.changed`.
- `/settings/ai-tools`, a lazily loaded route linked from Settings: one row per tool with a status pill, how it signs in, when it was checked and the problem in the UI's words with the engine's detail; Check now; "Sign in again" as the row's one primary action when it needs it; the other sign-in methods and Sign out (danger, confirmed) in the ⋯ menu, for `ai-tools.manage` only. `?signIn=<tool>` opens that tool's sign-in.
- The sign-in dialog renders onboarding's `PromptForm`, so the `harness-login` and `secret` forms are shared: the key lives in the DOM field and a one-time value only, the dialog polls while the engine verifies or a device login waits, and closing it abandons the sign-in.
- The chat's recheck card shows "Sign in again" (owners) or who can fix it (everyone else) when `recheck.aiToolId` is set.
- Audit labels for the new actions and target kind; English and Czech for every message.

## Out of scope

- A failed reply stream's `ai-tool-sign-in-required` problem in the thread itself (the recheck covers the engine's failed turns); installing a tool.

## Acceptance

- `ai-tools-page.test.tsx`: the list with statuses and no axe violations; Check now with a success or a warning toast; signing in again with a returned code; an API key refused then accepted, never in the document afterwards; signing out from the ⋯ menu; `?signIn=`; admins without the manage actions; the capability missing; Home's line; the chat's "Sign in again" for owners and the hint for others.
- The bundle budget holds, or is raised with the measured numbers and why.
