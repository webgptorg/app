# @ptbk/engine-ui

The full app for engine owners and members: agents, agent creation and editing, chat, runs, security panel, members, passkeys, secrets metadata, audit log.

It is built into a hashed static bundle, signed and logged as part of a release. The engine downloads it on update, verifies it and serves it from its own origin; we never serve it to browsers ([ADR 0003](../../docs/adr/0003-ui-as-signed-bundle.md)). It talks only to the engine API through `EngineApiClient` from `@ptbk/engine-api`.

Sign-in and setup are not here: they belong to the open engine gateway, and this UI loads only after authentication. A 401 `unauthenticated` from the API sends the browser to `SIGN_IN_PATH?next=<current path>`.

## The CSP is the contract

The bundle runs under `ENGINE_UI_CSP` from `@ptbk/engine-api`, verbatim: no inline scripts or styles, no `eval`, no external origins, Trusted Types with the single policy name `ptbk-html`. What follows from it:

- `index.html` holds one module script and one stylesheet link, nothing inline. Assets are never inlined as `data:` URLs (`assetsInlineLimit: 0`), and the modulepreload polyfill (an inline script) is off.
- No top-level await in the entry: it turns off Rolldown's merging of common chunks into the entry, which keeps `src/app/zod-jitless.ts` running before any zod schema is built (zod's `new Function` probe is a Trusted Types violation).
- React's `style` prop is fine (CSSOM); libraries that append `<style>` or set `style` attributes as strings are not. TanStack devtools inject styles, so they load only on the dev server.
- ESLint bans `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `setAttribute('style', …)` and `new Worker('<string>')` everywhere except `src/security/trusted-html.ts` (created by U-05).
- `src/security/csp-violation-listener.ts` logs violations loudly on the dev server (which sends no CSP) and records them into `window.__ptbkCspViolations` when a test harness defines it.

## Layout

```
index.html, vite.config.ts, vitest.config.ts, playwright.config.ts, tsr.config.json
bundle-budget.json      gzip budgets (entry, per route, CSS); the report goes to reports/, outside dist/
tooling/                the bundle budget Vite plugin
scripts/                release tooling run with Node (X-03): pack, verify-reproducible, attest, sign, verify, publish
scripts/release/        their tested core: manifest, archive, release entry, signing, R2 upload (tar codec, Sigstore verifier
                        and the pinned trusted root are in @ptbk/release-tools)
release/                build output (ignored), plus the staging trust policy
messages/en.json, cs.json   Paraglide catalogues (English is the source); src/paraglide/ is generated and not committed
project.inlang/             Paraglide project: locale strategy custom-storage (localStorage behind try/catch), browser, en
src/main.tsx            entry: zod-jitless, styles, applyTheme() before the first render, bootstrap
src/styles/app.css      Tailwind entry: tailwindcss, then @ptbk/ui (tokens, theme, fonts), @source for the package
src/app/                composition root: engine API client, query client, router (defaults: view transitions,
                        error, pending and not-found states), providers, locale, theme, typed Link, mutations,
                        API error mapping, the feature list (features.ts) and the registry (registry/)
src/routes/             file-based routes; src/routeTree.gen.ts is generated and not committed
src/features/<name>/    one folder per feature: <name>-feature.ts (its registry entry), <name>-keys.ts (query keys),
                        <name>-queries.ts (queryOptions), its screens
src/features/shell/     the app shell built from the registry: sidebar, engine switcher, trust mark, live indicator,
                        user menu, drawer below 768 px
src/features/session/   useCurrentMember(), usePermissions(), <Can>, requirePermission()
src/security/           CSP violation listener, safe-url
src/testing/            renderWithProviders(), the in-memory engine API for tests, expectNoAxeViolations()
test/                   app-level checks (Vitest, Node): dist/ and the budget report after a build, the lint rules
test/csp/               Playwright: the built bundle under the engine CSP, plus the UX checks
```

## Features and the registry

A feature (agents, runs, files, members, security …) is a folder under `src/features/` that describes itself once with `defineFeature()` (`src/app/registry/feature.ts`) and is listed in `src/app/features.ts`:

```ts
export const runsFeature = defineFeature({
  id: 'runs',
  requires: { capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' },
  nav: { group: 'work', order: 40, label: m.nav_runs, icon: Activity, to: '/runs' },
  agentTabs: [{ ...AGENT_TABS.runs, label: m.agent_tab_runs, to: '/agents/$agentId/runs' }],
  liveIndicator: { useActiveCount: useRunningCount },
  agentStatusProvider: { useAgentLiveState: useRunAgentLiveState },
  eventSync: { useEventSync: useRunEventSync },
});
```

The shell, guards and (later) the command palette and activity feed read these descriptions; nothing else knows features by name. A feature appears only when `GET /engine` advertises its capability (`supports` from `@ptbk/engine-api`; an engine on API 1.0 advertises none) and the member holds its permission; nested entries (`agentTabs`, `agentOverviewCards`, `commands`) are filtered the same way. Its routes call `requireFeature(id)` in `beforeLoad`, which renders "not available on this engine" or "no access" instead of the screen. `to` is typed against the route tree, so renaming a route breaks the entries that name it.

Agent detail tabs take their ID and order from `AGENT_TABS` (the order of docs/design/ui.md); the agent page (U-03) renders whatever tabs are visible, offers "Chat" and "Edit" in its header when the `chat` and `book` tabs exist, and never imports a tab's code. A tab route guards itself with `requireFeature(featureId, { agentTab })`, which also checks the tab's own `requires` (`anyPermission` for "any of these"). Until a feature ships its tab route, `/agents/$agentId/$tab` explains a registered but hidden tab ("not available", "no access") and answers "not found" otherwise. `agentOverviewCards` render in order, each inside its own error boundary and suspense fallback. The first visible `agentStatusProvider` supplies agent state; without one, the agents feature reads C-04's draft `GET /agents/{id}/status`.

Change events come from one shared subscription to `GET /events` (`src/app/engine-events.ts`, used through `useEngineEvents()`): it connects while any component listens, resumes with `Last-Event-ID`, backs off when the stream drops, and calls each subscriber's `onReconnect` after a gap so it can refetch what it derived from events. A feature whose data other screens show (the runs behind agent states and the live indicator) registers `eventSync`, which the shell mounts once for as long as it is on screen; screen-only syncs stay in their route layouts (agents, chat). `activityRenderers` (`kind` exact or `area.*`, with the `v` values they understand) are what the home feed (U-08) renders per item.

Live durations read one shared clock, `useNow()` (`src/app/ticker.tsx`): one interval for the whole app, none while nothing shows a live time or the tab is hidden. Nothing refetches to make time pass, and tests drive it with `createManualTicker()`.

Code checks permissions (`usePermissions().can()`, `<Can>`, `requirePermission()`), never role names; the role is a label. A test fails on any role-name comparison in `src/`.

## Conventions for later tasks

- Loaders prefetch with `queryClient.query({ ...xQueryOptions(context.engineApi, …), staleTime: 'static' })` (the former `ensureQueryData`) and components read the same `queryOptions` with `useSuspenseQuery`, so both hit one cache entry. Links preload on intent; `defaultPreloadStaleTime: 0` leaves freshness to TanStack Query.
- Search params are zod schemas in `validateSearch` with `.catch()` defaults, so a bad URL falls back instead of throwing.
- Server-side tables keep their state in typed search params and send it all to the engine: `useCursorPages` (`src/app/cursor-pages.ts`) for cursor paging, `useDebouncedSearch` for the search box, and `isInvalidCursor` / `isPageLevelFailure` (`src/app/list-errors.ts`) for an expired cursor and refusals the route explains.
- Write-only values (secrets) never enter React state, a form store, a query or mutation cache, the URL or a toast: `SensitiveInput` is read once on submit and emptied at once, and the value travels in a `OneTimeValue` (`src/features/secrets/one-time-value.ts`) that the mutation takes once and that serialises to nothing. Code that needs the form layer (`@tanstack/react-form`) loads it lazily, as the secret dialogs do.
- Client failures are mapped in one place, `src/app/api-errors.ts`. Queries retry at most twice and only on network errors, timeouts and 5xx.
- Every mutation goes through `useStepUpAwareMutation` (`src/app/mutations.ts`): `step-up-required` opens the step-up dialog (then `STEP_UP_PATH?returnTo=…`), a 403 says "not allowed", every other failure is a toast; an optional `optimistic: { apply, rollback }` is rolled back on failure and every listed query is refetched on settle; success toasts where the feature brief asks.
- Route-level states come from the router defaults (`src/app/route-states.tsx`): an error state with retry, a layout-shaped skeleton after 300 ms, not-found, and the access explanations.
- Screens are wrapped in `Page` (`src/features/shell/page.tsx`) for the one `h1`, and use `@ptbk/ui` components, semantic tokens and `Link` from `src/app/link.tsx` (`createLink(Anchor)`).
- No JSX text: every string is a Paraglide message (`m.key()`) in `messages/en.json` and `messages/cs.json`, which a test keeps in sync; plurals are variants over `Intl.PluralRules`. Dates and numbers go through `useLocale()` from `@ptbk/ui`.
- Every route passes `visit(path)` from `test/csp/fixtures.ts` and `expectCleanPage()`: no CSP or Trusted Types violation, console error, page error or foreign request; no serious or critical axe violation; no horizontal overflow at 360 × 740; cumulative layout shift below 0.1; once more with reduced motion.
- A route that needs more than its budget raises it in `bundle-budget.json` in the same PR, with the reason. The build fails over budget when `CI` is set.

## Commands

| Command                                     | What it does                                                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run --filter @ptbk/engine-ui generate` | Route tree (TanStack Router CLI); `bun run check` runs it first                                                                                                                                 |
| `bun run --filter @ptbk/engine-ui dev`      | Dev server; proxies `/api/v1` to `MOCK_ENGINE_URL` when set                                                                                                                                     |
| `VITE_ENGINE_API=memory … dev`              | Dev server on the in-memory engine API, no mock engine needed                                                                                                                                   |
| `bun run --filter @ptbk/engine-ui build`    | `dist/`: `index.html` and hashed assets, exactly what X-03 signs                                                                                                                                |
| `bun run --filter @ptbk/engine-ui test`     | Build, then Vitest with coverage (jsdom for `src/`, Node for `tooling/` and `test/`)                                                                                                            |
| `bun run --filter @ptbk/engine-ui test:csp` | Build with the gallery (`VITE_UI_GALLERY=1`), then Playwright against `vite preview` sending the engine CSP (CI job `engine-ui-csp`): every route and `/__gallery` in both themes and languages |
| `bun run --filter @ptbk/engine-ui pack`     | Release archive and manifest in `release/`; the release scripts are in [development.md](../../docs/development.md#ui-releases)                                                                  |

`test:csp` needs Chromium once: `bunx playwright install chromium` in this directory.

## Releases

`ui-release.yml` builds, signs and publishes the bundle on a `ui-v*` tag ([development.md](../../docs/development.md#ui-releases)). The archive is `engine-ui.tar.zst`: a deterministic ustar of `manifest.json` (C-06's `UiBundleManifest`, listing every file of `dist/` with its SHA-256) followed by `dist/`, compressed with zstd level 19. The bundle's version is the only build-specific value in it (`__PTBK_UI_VERSION__`, on `<html data-ui-version>`).

`release/trust-policy.staging.json` trusts the staging release key (its seed is the `UI_STAGING_RELEASE_KEY` secret of the `staging` environment) and this repository's `ui-release.yml` on a tag push. Its three maintainer keys are placeholders whose private halves were never kept, because C-06's `TrustPolicy` requires three: staging cannot accept a `security` release. The staging key must never appear in a production policy; production keys wait for the key ceremony (I-03).

The Sigstore verifier, the ustar codec and the pinned `trusted_root.json` live in [`@ptbk/release-tools`](../../packages/release-tools/README.md), because the mock engine's UI loader (M-05) runs the same code and apps cannot import each other.

Plan: tasks U-01 to U-07, X-03.
