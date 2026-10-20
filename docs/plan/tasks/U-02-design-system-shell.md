# U-02. Shared UI package, design system, app shell, i18n

- **Lane:** U · **Module:** `packages/ui`, `apps/engine-ui` (two modules, see Context) · **Milestone:** M2
- **Depends on:** U-01
- **Status:** todo
- **Spec:** One address for users, Enterprise-ready engine architecture (roles in one policy module), Security hardening (5), Engine security baseline; ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md), [0005](../../adr/0005-modular-architecture.md), [0007](../../adr/0007-frontend-stack.md), [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md); product brief: [docs/design/ui.md](../../design/ui.md)

## Goal

`@ptbk/ui` is a private, CSP-safe design system (three token layers, motion foundations, one module per component, forms, `DataTable`, `TrustMark`, `EngineSwitcher`, i18n helpers) used by engine-ui and the dashboard, and engine-ui has on top of it a typed feature registry and the authenticated app shell built from it, rendering by engine capability and the current member's permissions, with light and dark themes and English and Czech translations for every string, all running under the engine's CSP.

## Context

The feature tasks U-03 to U-12 run in parallel after this one, so the primitives, the shell, error handling, permissions and i18n must exist first. The dashboard is a Vite SPA on the same stack (TanStack Router, Query, Table, Paraglide, Tailwind 4) and shares the engine UI's visual language, so the design system lives in a package both apps consume: D-09 depends on this task, and the other dashboard screens (D-03, D-06, D-07, D-08) build on it through D-09.

**Two modules, one brief.** The package is only proven by a real consumer, so it lands together with the engine-ui shell that uses it. It may ship as two PRs (`packages/ui` first, then `apps/engine-ui`); the status line takes the last one. What goes where:

- **`packages/ui` (`@ptbk/ui`, UNLICENSED, already scaffolded empty):** design tokens and theme CSS, motion foundations, theme preference helpers, accessible components, form layer, `DataTable`, `TrustMark`, `EngineSwitcher`, i18n helpers (`UiProvider`, `Intl` formatters). Framework-level only: it depends on React, TanStack Table, TanStack Virtual, TanStack Form, zod, `motion` and `@noble/hashes`, and on nothing app-specific. It must not import `@ptbk/engine-api`, `@ptbk/protocol`, any app, TanStack Router or TanStack Query, and it ships no message catalogue and no permission code.
- **`apps/engine-ui`:** the Tailwind entry that imports the theme, the Paraglide catalogues and the `UiMessages` they feed, the router `Link` built from the package's `Anchor`, the typed feature registry, the shell and navigation built from it, route guards, `useCurrentMember`, `usePermissions`, `<Can>`, `requirePermission`, route-level error, pending and not-found components, step-up handling, query and mutation conventions.

**Predecessor code may be ported** (the license gate is lifted): the ManGo wizard and agents-server UI in the public `promptbook` repo and the TanStack prototype's hand-rolled `Button`, `Card`, `Field`, `Badge`, `Banner` (agents-server repo, `src/modules/onboarding/`). Port into `packages/ui`, then adapt: Tailwind 4 tokens instead of Tailwind 3 config, no router coupling (router links are built by each app), named exports, strict types, no Google Fonts `@import`, no runtime `<style>`, nothing from a CDN.

**Organizations and roles are ready from day one.** v0 has one owner, but nothing may assume a single user. The engine API exposes the current member, their organization, role and a permission list. The UI renders by capability through a hook, never by role name, so members, invites and custom roles later are additive. That hook is per app because it depends on each app's API; `@ptbk/ui` components only take plain props (`hidden`, `disabled`, `disabledReason`).

**Structure now, pixels later.** This task fixes structure, behaviour and the token architecture ([ADR 0015](../../adr/0015-ui-architecture-and-design-system.md)); the visual pass by Anka comes later and lands as a theme change (primitives and semantic mappings) plus component polish, without touching feature code. Features appear only when the engine advertises their capability and the member holds their permission ([ADR 0016](../../adr/0016-engine-capabilities.md)); the registry introduced here is how U-03 to U-12 plug in.

## Scope

### `packages/ui`

- Package: `react` and `react-dom` 19.3 and `zod` 4.6 as peer dependencies; `@tanstack/react-table` 9.3.x, `@tanstack/react-virtual` 3.14.x, `@tanstack/react-form` (Design notes), `lucide-react`, `motion` (Motion foundations below), `@noble/hashes` (catalog version; `TrustMark`), self-hosted OFL variable fonts per ADR 0015 (Outfit for display, Inter for UI text, plus a mono, e.g. `@fontsource-variable/*`) as dependencies. Versions shared with engine-ui or the dashboard (react, react-dom, zod, the TanStack packages) come from the root workspace catalog (`catalog:`), so both apps resolve one copy. Testing Library, jsdom and `axe-core` as dev dependencies; Vitest is the repo-wide 4.1.11 from the root. One public entry, `src/index.ts`; the theme CSS is reached through the same entry's `style` condition (Design notes).
- Layout:
  ```
  packages/ui/src/
    index.ts             the only public API
    theme.css            entry: imports the layers below and every component's tokens, @theme mapping, @custom-variant dark, base styles, font faces
    theme/
      primitives.css     raw palette, type scale, spacing, radii, shadows, durations, easings (--ptbk-*); the only file with primitives
      semantic.css       --color-*, --motion-* … with light and dark values, mapped from primitives
      preference.ts      ThemePreference, applyTheme(), read/persist with an injected storage
    fonts/               woff2 files referenced by theme.css
    motion/              useReducedMotion(), viewTransition helpers, the lazy `motion` wrapper
    components/
      button/            button.tsx, button.css (component tokens), button.gallery.tsx, button.test.tsx
      dialog/ …          same four files per module; composite patterns (data-table/, empty-state/, trust-mark/, engine-switcher/) too
    forms/               form layer over TanStack Form
    i18n/                UiMessages, UiProvider, useLocale(), Intl formatters
    gallery.tsx          collects every module's gallery entry
  ```
- **Three token layers** (ADR 0015), all CSS custom properties:
  1. _Primitives_ (`--ptbk-cyan-300`, `--ptbk-space-4`, `--ptbk-duration-200`, `--ptbk-ease-out` …) in `theme/primitives.css` only. Identity per ADR 0015: Promptbook cyan/mint accent used sparingly (primary actions, focus, live status), neutral surfaces, ink for dark surfaces, soft layered shadows.
  2. _Semantic_ (`--color-surface`, `--color-raised`, `--color-text`, `--color-text-muted`, `--color-border`, `--color-accent`, `--color-success`, `--color-warning`, `--color-danger`, `--color-focus`, `--motion-enter`, `--motion-exit`, `--motion-live` …) with light and dark values in `theme/semantic.css`. Tailwind 4's `@theme` maps them to utilities.
  3. _Component_ (`--button-primary-bg`, `--trust-mark-seal`, `--trust-mark-fp-1` … `--trust-mark-fp-6`) in each module's CSS file, defaulting to semantic tokens.

  Components and feature code use semantic or component tokens only. Dark mode is `@custom-variant dark` on a `.dark` class on `<html>`. `applyTheme(preference, root, matchMedia)` sets the class and `color-scheme`; preference `system | light | dark` is read and stored through a storage the app injects (wrapped in try/catch).

- **One component per module** (ADR 0015): each module has its component, its tokens, its gallery entry and its tests. Apps never restyle a component ad hoc; they use variants or tokens.
- **Motion foundations:** duration and easing primitives mapped to semantic motion tokens; CSS transitions and keyframes for most motion; the View Transitions API for route and layout changes (engine-ui turns on the router's view transitions); `motion` (CSP-safe: it animates through the CSSOM) loaded only by modules that need choreography, never in the entry chunk. Under `prefers-reduced-motion` the semantic motion tokens collapse to short fades or none, `useReducedMotion()` lets JS-driven motion do the same, and view transitions are skipped. Motion explains state (arrived, completed, live); it never decorates.
- Components (keyboard-operable, accessible name required where there is no visible label): `Button` (variants, `loading` with `aria-busy`), `IconButton` (label required by type), `Anchor` (styled `<a>`; apps wrap it with their router's `createLink`), `ExternalLink` (`rel="noopener noreferrer"`, visible host), `Field` (label, hint, error via `aria-describedby`, `aria-invalid`), `Input`, `Textarea`, `Select` (native), `Checkbox`, `Switch`, `Card`, `Badge` (always with text), `Banner` (info, success, warning, danger; `role="status"` or `role="alert"`), `Dialog` (native `<dialog>` with `showModal()`, focus moves in and returns to the opener), `ConfirmDialog` (optional typed confirmation), `Drawer` (native `<dialog>` as a side sheet, same focus rules), `Menu` (Popover API, roving focus, `Esc` closes and returns focus), `Tabs` (ARIA tabs pattern, controlled so apps can bind the selected tab to the URL), `Toaster` and `useToast()` (one `aria-live="polite"` region, errors stay until dismissed, auto-dismiss pauses on hover and focus, a `toast.promise`-style helper for async outcomes), `Skeleton` (fixed dimensions, `aria-hidden`; the container sets `aria-busy`), `Spinner`, `EmptyState`, `ErrorState` (message, retry action, optional details), `Pagination` (cursor: previous and next, optional total), `CodeText`, `CopyButton`, `RelativeTime`, `VisuallyHidden`, `SkipLink`. Icons: `lucide-react`.
- `TrustMark` (`components/trust-mark/`): a custom SVG Promptbook seal, not a padlock, with props `{ engineId: string | null, state: 'verifying' | 'verified', size, label }`. Moving to `verified` plays a calm CSS-keyframe seal animation (about 600 ms, stroke draw and settle, from motion tokens; none under reduced motion). It carries the **engine fingerprint**: `deriveEngineFingerprint(engineId)` takes a synchronous SHA-256 (`@noble/hashes`) over the domain prefix `ptbk-fingerprint-v1` followed by the engine ID and yields a 12-character Crockford base32 code shown as `XXXX-XXXX-XXXX` plus a horizontally symmetric 5×5 pattern coloured from the component tokens `--trust-mark-fp-*`. Rendered from the engine ID only and deterministic; `role="img"` with an `aria-label` that contains the code, the code also rendered as text, pattern never the only carrier. Committed vectors `fingerprint-vectors.json` (engine ID → code and pattern bits) pin the derivation, so engine-ui and the dashboard (D-06) show the same mark for the same engine by construction. With `engineId: null` the seal renders without a fingerprint.
- `EngineSwitcher` (`components/engine-switcher/`): a Stripe-style menu (on `Menu`) opened from the current engine's name and `TrustMark`, fed entirely by the app: `{ current: { name, engineId, hostname }, engines: [{ name, engineId, hostname, status }], allEnginesHref, addEngineHref }`. Items are plain anchors to other origins; it fetches nothing.
- Form layer (`forms/`): zod-validated forms with `Form`, `FormField` bindings that wire a field to `Field` (label, hint, error, `aria-*`), submit state on `Button`, focus on the first invalid field after a failed submit, and `applyServerErrors(form, errors)` for a locally defined `{ path, message }[]` shape (structurally matching RFC 9457 validation errors, without importing any contract). `SensitiveInput`: an uncontrolled input never registered with the form store, read once through a ref on submit and cleared after success and failure (U-06 secrets).
- `DataTable` over TanStack Table:
  - Server-side mode: sorting, column filters and cursor pagination are controlled props with change callbacks, so each app binds them to typed search params; nothing is sorted or filtered on the client in this mode. Client-side mode for small, fully loaded lists.
  - Column visibility menu, persisted per device through an injected storage key. Row selection (checkbox column, select page, accessible names). Row expansion (button with `aria-expanded`, used by U-07). A row actions slot rendered as a `Menu`.
  - Sortable headers are buttons with `aria-sort`. Real `<table>` semantics with a caption.
  - Built-in loading (skeleton rows of stable height), empty, no-results and error states; previous data stays visible and dimmed with `aria-busy` while the next page loads.
  - Virtualised body with TanStack Virtual above a row-count threshold (rows positioned through React's `style` prop).
  - Below 768 px rows render as cards from column metadata (priority, label), so a table never causes horizontal page scroll.
  - Re-exports the column helper and column types apps need, so apps do not pin a second copy of TanStack Table.
- i18n helpers (`i18n/`): `@ptbk/ui` contains no user-visible literal. `UiMessages` is an interface with every string the components need (close, previous, next, loading, no results, retry, copy, copied, columns, select row, sort ascending and descending, …); each app supplies it to `<UiProvider messages locale>` from its own Paraglide functions, so a missing message is a type error. `useLocale()` and memoised `Intl` formatters for dates, numbers and relative times.
- Boundaries: an ESLint override for `packages/ui/**` with `no-restricted-imports` banning `@ptbk/*`, `apps/*`, `@tanstack/react-router` and `@tanstack/react-query`, the same DOM bans as engine-ui (U-01), and the JSX string-literal rule.
- Component gallery (`src/gallery.tsx`, exported, built from each module's gallery entry): every component in every state, in both themes, with and without reduced motion. engine-ui mounts it only in the `test:csp` build (below).

### `apps/engine-ui`

- Wiring: `@ptbk/ui` as a `workspace:*` dependency. `src/styles/app.css` imports `tailwindcss`, then `@ptbk/ui`, and adds the package's `src` as an `@source`. `applyTheme()` runs as the first statement of `main.tsx` (inline scripts are not allowed). `UiProvider` and `Toaster` in `src/app/providers.tsx`. `src/app/link.tsx` builds the app's typed `Link` with TanStack Router's `createLink(Anchor)`.
- Session and permissions in `src/features/session/`: `useCurrentMember()` (member ID, display name, organization ID, role label, permissions, from C-04); `usePermissions()` returning `can(permission)`; `<Can permission>`; `requirePermission(permission)` for route `beforeLoad`, which renders a "no access" page. Permissions are the string union C-04 exports (`agents.read`, `agents.delete`, `secrets.manage`, `audit.read`, …); unknown strings from a newer engine are ignored. The role is shown as a label only.
- **Feature registry** (`src/app/registry/`): a feature (agents, runs, files, triggers, integrations, members, security …) is a folder under `src/features/` that describes itself with
  ```ts
  defineFeature({
    id,
    requires: { capability?: CapabilityRef, permission?: Permission },
    nav?: { group: 'work' | 'resources' | 'admin', order, label, icon, to },
    agentTabs?: [{ id, order, label, to, requires? }],
    agentOverviewCards?: [{ id, order, component, requires? }],
    activityRenderers?: [{ kind /* exact or 'prefix.*' */, versions, component, summary }],
    commands?: [{ id, label, keywords, requires?, to | run }],
    attention?: { id, useAttention() /* → { count, to } */ },
    liveIndicator?: { useActiveCount() },
    agentStatusProvider?: { useAgentLiveState(agentId) },
  });
  ```
  The static, typed `FEATURES` list lives in `src/app/features.ts`. `useEngineCapabilities()` reads C-04's `GET /engine` (`capabilities` arrives with C-07; missing means `[]`), `useVisibleFeatures()` filters `FEATURES` and their nested entries by capability (`supports` from C-07) and `can()`, and `requireFeature(id)` in a route's `beforeLoad` renders "not available on this engine" or "no access". Routes stay file-based for code splitting; the registry names them through the router's typed `to`, so a renamed route is a type error.
- App shell (`src/routes/__root.tsx`, `src/features/shell/`), built from the registry, per [docs/design/ui.md](../../design/ui.md):
  - **Sidebar** with the `EngineSwitcher` at the top and grouped sections: _work_ (Home, Agents, Chats, Runs), _resources_ (Files, Triggers, Integrations), _admin_ (Members, Security, Secrets, Audit log, Settings). An item appears only when a feature registers it and its capability and permission allow it. Collapses to icons (persisted per device), becomes a `Drawer` below 768 px. Skip-to-content link.
  - **Engine switcher:** engine-ui cannot list other engines (`connect-src 'self'`), so it feeds `EngineSwitcher` with the current engine (name and hostname from `GET /engine`) plus "All engines" and "Add engine" anchors to `dashboardUrl` (and `dashboardUrl` + `/engines/new`), hidden when `dashboardUrl` is `null`.
  - **Trust mark** in the shell from `GET /engine`'s `engineId` (added by C-07; until then it renders without a fingerprint); activating it opens `/security` (U-06 fills the panel).
  - **Live indicator:** a quiet, breathing dot with a text label when the sum of registered `liveIndicator` counts is above zero; absent otherwise.
  - User menu (member name and role label, language, theme, sign out through C-04's `SIGN_OUT_PATH`, then full-page navigation).
- This task registers the core features whose stubs it owns (agents placeholder, members, security, secrets, audit, settings); U-03 to U-12 add or fill theirs.
- Route stubs for `/security`, `/members`, `/secrets`, `/audit`, `/settings` with their `requireFeature` guards (filled by U-06, U-07); `/settings` gets language and theme now. Router defaults replacing U-01's placeholders: `defaultViewTransition` on (skipped under reduced motion), `defaultErrorComponent` (`ErrorState` with retry that resets the query error boundary and invalidates the route), `defaultPendingComponent` (layout-shaped skeleton, shown after `defaultPendingMs` so fast loads do not flash), `defaultNotFoundComponent`, and a root error boundary.
- Step-up: when the API returns the step-up-required error (C-04), a dialog explains why and navigates to C-04's `STEP_UP_PATH` with `returnTo`. Helper `useStepUpAwareMutation`. A 403 shows a "not allowed" message, never a crash.
- Mutation conventions in `src/app/mutations.ts`, used by every feature: `useStepUpAwareMutation` accepts an optional optimistic `{ apply, rollback }` (snapshot in `onMutate`, restore in `onError`, invalidate in `onSettled`) and reports outcomes through toasts (errors always, success where the brief asks for it). Query-key factory and `queryOptions` convention from U-01.
- i18n with **Paraglide JS 2** (`@inlang/paraglide-js`): catalogues `messages/en.json` (source) and `messages/cs.json`, compiled into typed, tree-shakable functions (`m.agents_title()`). The compiled output is generated, not committed: engine-ui's `generate` script (U-01) also runs the Paraglide compiler, so `bun run check` produces it before lint and typecheck; the Vite plugin does the same in dev and build. Plurals as Paraglide variants over `Intl.PluralRules` (Czech: one, few, many, other). Locale strategy: `localStorage`, then `preferredLanguage`, then `en`; no cookie, no URL prefix. `<html lang>` follows the locale. Dates, numbers and relative times through `@ptbk/ui`'s `Intl` formatters. `src/app/ui-messages.ts` maps the catalogue onto `UiMessages`.
- `test:csp` build mode (`VITE_UI_GALLERY=1`) adds a `/__gallery` route rendering `@ptbk/ui`'s gallery; it is tree-shaken from production builds and a test proves it, like the in-memory client in U-01.

## Out of scope

- Feature screens (U-03 to U-12), including the command palette (U-08). Sign-in, setup and step-up pages (engine gateway).
- Wiring `@ptbk/ui` into the dashboard, its shell and its permission hook (D lane).
- Member management, invites, role editing (v1; U-06 shows members read-only).
- Listing the member's other engines in engine-ui's switcher (see Risks); the dashboard feeds the full list (D-06, D-09).
- The visual pass (Anka): a later theme change through primitives, semantic mappings and component polish.

## Design notes

- **CSS through the single entry.** `packages/ui/package.json` keeps one `exports` key: `".": { "style": "./src/theme.css", "default": "./src/index.ts" }`. Tailwind 4's CSS `@import "@ptbk/ui"` resolves the `style` condition; TypeScript and Vite resolve `default`. Font files are referenced relatively from `theme.css`, so Vite emits them as hashed assets (`assetsInlineLimit: 0` from U-01 keeps them out of `data:` URLs).
- **Forms: TanStack Form** (decided; `@tanstack/react-form` 1.x, newest patch at least 7 days old). It is headless and keeps state in React, so it adds no DOM or style injection; it validates with zod 4 schemas directly through Standard Schema, without a resolver package; field paths are typed; async validation supports debounce and abort; and it matches the rest of the stack. Considered: react-hook-form (mature, but needs `@hookform/resolvers` and fights controlled components), an in-house `useZodForm` (smallest, but re-implements touched, dirty, async and array fields). Secret values never enter any form store: `SensitiveInput` exists for that.
- **CSP-safe by construction.** No runtime `<style>` elements, no `insertRule`, no string `style` attributes, no inline scripts, no `innerHTML`. React's `style` prop is fine (CSSOM; U-01). Native elements first, no headless UI library: several append `<style>` or scroll-lock styles at runtime. TanStack Table and Virtual are headless and render nothing themselves. Dev tools that inject styles (TanStack devtools) stay behind `import.meta.env.DEV`.
- Why Paraglide: messages compile to plain functions at build time, so there is no runtime message parser and no eval; unused messages are tree-shaken; calls are type-checked; output is deterministic (X-03 reproducibility); and the dashboard's Vite SPA uses the same tool, so both apps share one approach and one `UiMessages` contract with `@ptbk/ui`. Rejected: i18next (runtime interpretation, loose typing, larger), FormatJS (runtime ICU parsing unless precompiled), Lingui (needs a Babel macro step).
- No user-visible string literal in JSX, in either module: an ESLint rule (`no-restricted-syntax` on JSX text with letters, allowing an ignore list) keeps strings in the catalogues.
- Never compare `member.role` in code; a unit test greps `apps/engine-ui/src/` for role-name comparisons and fails.
- **UX bar** (every U task meets it; U-01 provides the checks, this task provides the means):
  - every view has loading skeletons, an empty state and an error state with retry; route-level error boundaries catch the rest;
  - mutations use optimistic UI with rollback where it is safe (the feature brief says where), and every async outcome is reported (toast or inline);
  - full keyboard operation with a visible focus ring; dialogs, drawers and menus move focus in, trap it and return it; status is never colour-only;
  - WCAG 2.2 AA: contrast 4.5:1 for body text and 3:1 for large text, borders and focus rings, labels on every control, `axe-core` in unit tests and in `test:csp`;
  - responsive down to 360 px with no horizontal page scroll;
  - `prefers-reduced-motion` respected (motion tokens collapse, Tailwind `motion-safe:` for every transition, no view transitions);
  - tokens only: no hard-coded colour, size or duration in a component or feature;
  - no layout shift on load (skeletons sized like the content, font fallbacks with matching metrics);
  - per-route bundle budgets checked in CI (U-01);
  - links preload route code and data on hover and focus (U-01 router defaults);
  - every string translated in English and Czech.
- Contrast: a pure function computes WCAG contrast for each token pair in both themes and lives in `@ptbk/ui` with its test.
- Token boundary: a test scans `packages/ui/src` and `apps/engine-ui/src` and fails when a `--ptbk-*` primitive is referenced outside `theme/`, or a hex, `rgb()` or `oklch()` literal appears outside `theme/primitives.css`.
- The fingerprint is a recognition aid users compare across devices (like Signal safety numbers); the security property stays the engine ID in the hostname. Changing the derivation changes every mark, so the domain prefix carries a version.
- `renderWithProviders()` gains `locale`, `theme` and `permissions` options and mounts `UiProvider` and `Toaster`.

## Acceptance criteria

- [ ] `@ptbk/ui`: each component module has its tokens file, gallery entry and tests for keyboard use and accessible name; `axe-core` finds no violations in either theme; `Dialog`, `Drawer` and `Menu` trap focus and return it to the opener.
- [ ] Contrast test passes for all token pairs in light and dark; the token-boundary test passes, and a fixture component using a primitive or a hex literal makes it fail.
- [ ] Swapping `theme/primitives.css` for a test palette changes the rendered gallery colours with no other file touched (test).
- [ ] Motion: with reduced motion emulated, semantic motion tokens resolve to the reduced values, `useReducedMotion()` returns true and route changes skip view transitions; `motion` is absent from the entry chunk.
- [ ] `TrustMark`: `deriveEngineFingerprint` matches every entry in `fingerprint-vectors.json`; the same engine ID always renders the same pattern and code; the accessible name contains the code; `verifying` → `verified` adds the seal animation class, none under reduced motion; `engineId: null` renders without a fingerprint.
- [ ] `EngineSwitcher`: keyboard-operable menu; items are anchors with the given hrefs; in engine-ui it shows the current engine and the dashboard links, which are absent when `dashboardUrl` is `null`.
- [ ] Registry: with no capabilities advertised, capability-gated features are absent from the sidebar and their routes show "not available on this engine"; with a capability but without its permission they show "no access"; nested entries (`agentTabs`, `commands` …) are filtered the same way; an unknown capability is ignored.
- [ ] Shell: sidebar groups render in the order of docs/design/ui.md; collapse to icons persists across reload; the live indicator shows with a text label when a registered count is above zero and is absent at zero.
- [ ] `DataTable` tests: sorting, filters, column visibility, selection and expansion emit controlled state changes in server-side mode without reordering rows locally; cursor paging calls back with the right cursor; loading, empty, no-results and error states render; 10,000 rows with virtualisation mount only the visible window; at 360 px rows render as cards.
- [ ] Form tests: zod errors are linked through `aria-describedby`; a failed submit focuses the first invalid field; `applyServerErrors` maps errors to fields; a `SensitiveInput` value is absent from the form store and from the DOM after submit.
- [ ] Lint fails when `packages/ui` imports `@ptbk/engine-api` or `@tanstack/react-router` (lint fixture or `RuleTester`); no JSX string literal exists in either module.
- [ ] A test fails when `cs.json` and `en.json` key sets differ; Czech plurals are tested for 0, 1, 2 and 5; `UiMessages` is fully supplied from the catalogue (type check).
- [ ] Permissions: with an empty permission list the sidebar shows only Settings and guarded routes show "no access"; with full permissions every item shows; an unknown permission string is ignored.
- [ ] Shell: theme and language persist across reload (fake `localStorage`); sign out calls the sign-out endpoint; below 768 px the sidebar opens as a drawer and returns focus on close.
- [ ] A route whose loader throws shows the route error state, and retry recovers when the next call succeeds; step-up and 403 paths each have a test.
- [ ] `test:csp` visits every route and `/__gallery` in both themes and both languages with zero violations, at 1280 px and 360 px without horizontal overflow, with a cumulative layout shift below 0.1 and with reduced motion emulated; fonts load from `'self'`; the gallery is absent from the production build.
- [ ] Bundle budgets from U-01 pass with the shell in place; the budget file records the new baseline.
- [ ] Ported files are listed in the PR description with their source path.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- If Tailwind's resolver or the isolated linker does not honour the `style` condition, flag it instead of adding a second `exports` entry or a relative path into the package.
- `@tanstack/react-table` 9 changed its API from v8; ported table code and online examples are mostly v8. If 9.3.x lacks something `DataTable` needs, flag it rather than dropping to v8.
- The dashboard (D-01, Vite SPA with Paraglide) consumes the same package: once it does, a change to `UiMessages` or to component props is breaking for both apps.
- Listing the member's other engines in engine-ui's switcher needs data from the dashboard, which engine-ui cannot fetch; options (passing a signed list on navigation, a per-origin cache) need a security review. Until decided, engine-ui shows only the current engine and links to the dashboard.
- The fingerprint code is 100 bits (20 base32 characters in groups of 4), so a targeted key search to match it is infeasible; the visual pattern is derived from the same bits. Shared test vectors fix the derivation (decided 2026-10-20).
