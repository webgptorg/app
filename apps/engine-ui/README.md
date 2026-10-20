# @ptbk/engine-ui

The full app for engine owners and members: agents, agent creation and editing, chat, security panel, secrets metadata, audit log.

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
src/main.tsx            entry: zod-jitless, styles, bootstrap
src/app/                composition root: engine API client, query client, router, providers, API error mapping
src/routes/             file-based routes; src/routeTree.gen.ts is generated and not committed
src/features/<name>/    one folder per feature: <name>-keys.ts (query keys), <name>-queries.ts (queryOptions)
src/security/           CSP violation listener, safe-url
src/test/               renderWithProviders(), the in-memory engine API for tests, expectNoAxeViolations()
tests/build/            checks on dist/ and the budget report (Vitest, after a build)
tests/lint/             the lint rules above, proven on real files
tests/csp/              Playwright: the built bundle under the engine CSP, plus the UX checks
```

## Conventions for later tasks

- Loaders prefetch with `queryClient.query({ ...xQueryOptions(context.engineApi, …), staleTime: 'static' })` (the former `ensureQueryData`) and components read the same `queryOptions` with `useSuspenseQuery`, so both hit one cache entry. Links preload on intent; `defaultPreloadStaleTime: 0` leaves freshness to TanStack Query.
- Search params are zod schemas in `validateSearch` with `.catch()` defaults, so a bad URL falls back instead of throwing.
- Client failures are mapped in one place, `src/app/api-errors.ts`. Queries retry at most twice and only on network errors, timeouts and 5xx.
- Every route passes `visit(path)` from `tests/csp/fixtures.ts` and `expectCleanPage()`: no CSP or Trusted Types violation, console error, page error or foreign request; no serious or critical axe violation; no horizontal overflow at 360 × 740; cumulative layout shift below 0.1; once more with reduced motion.
- A route that needs more than its budget raises it in `bundle-budget.json` in the same PR, with the reason. The build fails over budget when `CI` is set.

## Commands

| Command                                     | What it does                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `bun run --filter @ptbk/engine-ui generate` | Route tree (TanStack Router CLI); `bun run check` runs it first                               |
| `bun run --filter @ptbk/engine-ui dev`      | Dev server; proxies `/api/v1` to `MOCK_ENGINE_URL` when set                                   |
| `VITE_ENGINE_API=memory … dev`              | Dev server on the in-memory engine API, no mock engine needed                                 |
| `bun run --filter @ptbk/engine-ui build`    | `dist/`: `index.html` and hashed assets, exactly what X-03 signs                              |
| `bun run --filter @ptbk/engine-ui test`     | Build, then Vitest with coverage (jsdom for `src/`, Node for `tooling/` and `tests/`)         |
| `bun run --filter @ptbk/engine-ui test:csp` | Build, then Playwright against `vite preview` sending the engine CSP (CI job `engine-ui-csp`) |

`test:csp` needs Chromium once: `bunx playwright install chromium` in this directory.

Plan: tasks U-01 to U-07.
