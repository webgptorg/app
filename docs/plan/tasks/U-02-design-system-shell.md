# U-02. Design system, app shell, i18n

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-01 · **Unblocks:** U-03, U-05, U-06, U-07
- **Status:** todo
- **Spec:** One address for users, Enterprise-ready engine architecture (roles in one policy module), Security hardening (5), Engine security baseline; ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md)

## Goal

A small, accessible component library, the authenticated app shell, capability-based rendering from the current member's permissions, light and dark themes, and English and Czech translations for every string, all running under the engine's CSP.

## Context

The feature tasks U-03 to U-07 run in parallel after this one, so the primitives, the shell, error handling, permissions and i18n must exist first. The spec wants the engine UI to share the dashboard's visual language, with a link back in the header.

**Predecessor code may be ported** (the license gate is lifted): the ManGo wizard and agents-server UI in the public `promptbook` repo and the TanStack prototype's hand-rolled `Button`, `Card`, `Field`, `Badge`, `Banner` (agents-server repo, `src/modules/onboarding/`). Port, then adapt: Tailwind 4 tokens instead of Tailwind 3 config, TanStack Router instead of Next.js, named exports, strict types, no Google Fonts `@import`, no runtime `<style>`, nothing from a CDN.

**Organizations and roles are ready from day one.** v0 has one owner, but nothing may assume a single user. The engine API exposes the current member, their organization, role and a permission list. The UI renders by capability through a hook, never by role name, so members, invites and custom roles later are additive.

## Scope

- Tokens in `src/styles/app.css` with Tailwind 4 `@theme`: colours (surface, text, muted, border, accent, success, warning, danger, each with a dark value), radii, spacing, fonts. Self-hosted variable fonts (a sans and a mono, OFL-licensed, e.g. `@fontsource-variable/*`) bundled as files.
- Dark mode: `@custom-variant dark` on a `.dark` class on `<html>`; preference `system | light | dark` stored per device in `localStorage`, applied as the first statement of `main.tsx` (inline scripts are not allowed), `color-scheme` set accordingly.
- Primitives in `src/ui/` (one file each): `Button`, `IconButton` (requires a label), `Link`, `ExternalLink` (`rel="noopener noreferrer"`, visible host), `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `Field` (label, hint, error via `aria-describedby`, `aria-invalid`), `Card`, `Badge`, `Banner`, `Dialog` (native `<dialog>`, `showModal()`), `ConfirmDialog` (optional typed confirmation), `Menu` (Popover API), `Tabs`, `Table`, `Pagination` (cursor: previous/next), `EmptyState`, `Skeleton`, `Spinner`, `Toaster` (one `aria-live="polite"` region), `CodeText`, `CopyButton`, `RelativeTime`. Icons: `lucide-react`.
- Session and permissions in `src/features/session/`: `useCurrentMember()` (member ID, display name, organization ID, role label, permissions, from C-04); `usePermissions()` returning `can(permission)`; `<Can permission>`; `requirePermission(permission)` for route `beforeLoad`, which renders a "no access" page. Permissions are the string union C-04 exports (`agents.read`, `agents.delete`, `secrets.write`, `audit.read`, …); unknown strings from a newer engine are ignored. The role is shown as a label only.
- App shell (`src/routes/__root.tsx`, `src/features/shell/`): header with engine name and hostname (engine info endpoint), link back to the dashboard (URL from engine info; hidden when absent, e.g. direct or local mode), user menu (member name and role label, language, theme, sign out through the engine's sign-out endpoint, then full-page navigation). Sidebar: Agents, Security, Members, Secrets, Audit log, Settings, each shown only when `can()` allows it; collapses to a menu below 768 px.
- Route stubs for `/security`, `/members`, `/secrets`, `/audit`, `/settings` with their `requirePermission` guards (filled by U-06, U-07); `/settings` gets language and theme now. Not-found route, root error boundary with retry.
- Step-up: when the API returns the step-up-required error (C-04), a dialog explains why and navigates to the engine's step-up page with `returnTo`. Helper `useStepUpAwareMutation`. A 403 shows a "not allowed" message, never a crash.
- i18n with **Paraglide JS 2** (`@inlang/paraglide-js`): catalogues `messages/en.json` (source) and `messages/cs.json`, compiled by the Vite plugin into typed, tree-shakable functions (`m.agents_title()`). Plurals as Paraglide variants over `Intl.PluralRules` (Czech: one, few, many, other). Locale strategy: `localStorage`, then `preferredLanguage`, then `en`; no cookie, no URL prefix. `<html lang>` follows the locale. Dates, numbers and relative times through `Intl`.

## Out of scope

- Feature screens (U-03 to U-07). Sign-in, setup and step-up pages (engine gateway).
- Member management, invites, role editing (v1; U-06 shows members read-only).
- An engine switcher listing engines: engine-ui cannot fetch the dashboard (`connect-src 'self'`).

## Design notes

- Why Paraglide: messages compile to plain functions at build time, so there is no runtime message parser and no eval; unused messages are tree-shaken; calls are type-checked; output is deterministic (X-03 reproducibility); and the same tool works in the dashboard's TanStack Start on Workers, so both apps share one approach. Rejected: i18next (runtime interpretation, loose typing, larger), FormatJS (runtime ICU parsing unless precompiled), Lingui (needs a Babel macro step).
- No user-visible string literal in JSX: an ESLint rule (`no-restricted-syntax` on JSX text with letters, allowing an ignore list) keeps strings in the catalogues.
- Native elements first, no headless UI library; anything that injects `<style>` or string `style` attributes is ruled out by the CSP.
- Never compare `member.role` in code; a unit test greps `src/` for role-name comparisons and fails.
- Visible focus ring everywhere; dialogs return focus; skip-to-content link. Status is never colour-only.
- Contrast: a pure function computes WCAG contrast for each token pair in both themes; required 4.5:1 for body text, 3:1 for large text and borders.
- `renderWithProviders()` gains `locale`, `theme` and `permissions` options.

## Acceptance criteria

- [ ] Each primitive has tests for keyboard use and accessible name; `axe-core` finds no violations in either theme.
- [ ] Contrast test passes for all token pairs in light and dark.
- [ ] A test fails when `cs.json` and `en.json` key sets differ; Czech plurals are tested for 0, 1, 2 and 5.
- [ ] Permissions: with an empty permission list the sidebar shows only Settings and guarded routes show "no access"; with full permissions every item shows; an unknown permission string is ignored.
- [ ] Shell: theme and language persist across reload (fake `localStorage`); sign out calls the sign-out endpoint.
- [ ] Step-up and 403 paths each have a test.
- [ ] `test:csp` visits every route in both themes and both languages with zero violations; fonts load from `'self'`.
- [ ] Ported files are listed in the PR description with their source path.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- C-04 must provide the current-member endpoint (member, organization, role, permissions), the permission union and the engine info endpoint (name, hostname, dashboard URL, sign-out and step-up paths). Amend the contract first if missing.
- D-01 should adopt Paraglide too so both apps use one i18n approach; tell the dashboard lane.
- Shared tokens with the dashboard would need a package (e.g. `packages/design-tokens`); decide when D-06 starts.
