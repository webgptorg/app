# U-01. Engine UI scaffold under the engine's CSP

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** C-04 · **Unblocks:** U-02, X-03
- **Status:** todo
- **Spec:** Architecture (UI delivery), Engine security baseline (Browser headers), Security hardening (5, 6), Hosting and stack (TypeScript stack); ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md), [0004](../../adr/0004-mock-engine-and-conformance.md), [0005](../../adr/0005-modular-architecture.md)

## Goal

`apps/engine-ui` builds into a static, content-hashed bundle that boots, routes and talks to the engine API through an injected `EngineApiClient`, and a browser test proves it runs under the engine's exact CSP with zero violations.

## Context

The engine downloads our bundle, verifies it and serves it from its own origin (ADR 0003). The open engine owns the pre-auth gateway, sign-in, setup and WebAuthn pages and the CSP headers; engine-ui loads only after the user is signed in. Whatever this scaffold allows (inline styles, a CDN font, a `<style>` injected by a library) every later task inherits, so the CSP is enforced from the first commit. Every later U task builds on the layout and test helpers defined here.

## Scope

- Package setup: Vite 8.3, React 19.3, `@vitejs/plugin-react`, TanStack Router 1.170 with `@tanstack/router-plugin` (file-based routes, `autoCodeSplitting: true`), TanStack Query 5.104, Tailwind 4.3 via `@tailwindcss/vite`, zod 4.6, Vitest 5 + `@testing-library/react` + `@testing-library/user-event` + jsdom, `@playwright/test` 1.64. Scripts: `dev`, `build`, `preview`, `typecheck`, `test`, `test:csp`.
- Layout:
  ```
  apps/engine-ui/
    index.html, vite.config.ts, playwright.config.ts
    src/main.tsx                 entry: calls app/bootstrap
    src/app/                     composition root: engine-api-client.ts, query-client.ts, router.ts, providers.tsx
    src/routes/                  __root.tsx, index.tsx (redirect to /agents), agents/index.tsx (placeholder)
    src/routeTree.gen.ts         generated, committed
    src/features/                one folder per feature (filled by U-03..U-07)
    src/security/                csp-violation-listener.ts, safe-url.ts
    src/test/                    renderWithProviders(), in-memory client wiring
    tests/csp/                   Playwright CSP smoke test
  ```
- `EngineApiProvider` (React context) and `useEngineApi()`; the client is also put in the router context so route loaders can prefetch with `queryClient.ensureQueryData`. Production uses the HTTP client from `@ptbk/engine-api`; tests use the in-memory client.
- Dev mode: `vite dev` proxies the engine API prefix (from C-04) to the mock engine (M-04) at `MOCK_ENGINE_URL`. `VITE_ENGINE_API=memory` swaps in the in-memory client via a dynamic import guarded by `import.meta.env.DEV`, so it is tree-shaken from production builds.
- A 401 from the API triggers a full-page navigation to the engine's sign-in path (from C-04) with a `next` parameter; engine-ui never renders a sign-in form.
- CSP violation listener (`securitypolicyviolation` on `document`): in dev it logs loudly; in test and in `test:csp` it records violations on `window.__ptbkCspViolations` so tests fail.
- ESLint override for `apps/engine-ui/**`: browser globals, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, and bans on `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `setAttribute('style', ...)` and `new Worker(<string>)` everywhere except `src/security/trusted-html.ts` (created by the first task that truly needs HTML, see U-05). Ignore `routeTree.gen.ts` in ESLint and Prettier.
- `test:csp`: build, serve `dist/` with `vite preview` sending the engine's CSP header, load `/` and `/agents` in Chromium, and fail on any recorded violation, console CSP or Trusted Types error, uncaught page error, or request to a non-`'self'` origin. Wire it into a CI job (separate from `check`, Chromium installed with `playwright install --with-deps chromium`).

## Out of scope

- Design system, shell, i18n, dark mode (U-02). Feature screens (U-03 to U-07).
- Sign-in, setup, step-up and WebAuthn pages: engine gateway, open source.
- Manifest, packing, signing (X-03). Serving the bundle through the loader (M-05).

## Design notes

- The CSP the bundle must survive, verbatim: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types ptbk-html`. It is a contract between the engine and the bundle: import it from `@ptbk/engine-api` (`ENGINE_UI_CSP`) so the mock engine, conformance and the real engine use the same string.
- Vite config: `build.assetsInlineLimit: 0` (fonts or SVGs inlined as `data:` would break `font-src 'self'`), `build.modulePreload.polyfill: false`, `build.sourcemap: false`, `base: '/'`, content-hashed file names under `assets/`. Nothing in `index.html` besides one `<script type="module" src>` and one stylesheet link.
- The Vite dev server injects inline scripts and `<style>` for HMR, so the strict CSP is only checked against the built bundle; dev keeps the listener but no enforced CSP.
- React's `style` prop is allowed because React applies it through CSSOM, which CSP does not block. Libraries that append `<style>` elements or set `style` attributes as strings are not allowed.
- Query client defaults: no retry on 4xx, at most 2 retries on network errors and 5xx, `refetchOnWindowFocus` on.
- Errors from the client are the typed unions C-04 defines; map them in one place (`src/app/api-errors.ts`), not per component.

## Acceptance criteria

- [ ] `bun run --filter @ptbk/engine-ui build` produces `dist/index.html` plus hashed assets only; no `data:` URLs or external URLs in any emitted file (unit test scans `dist/`).
- [ ] `test:csp` passes; a deliberately added inline `<style>` in a test fixture page makes it fail (negative test kept in the suite).
- [ ] Unit test renders the root route with the in-memory client and shows the placeholder agents route; a 401 from the client triggers navigation to the sign-in path.
- [ ] The production bundle contains no in-memory client code (test greps `dist/` for a marker string exported by it).
- [ ] ESLint fails on `dangerouslySetInnerHTML` in a component (rule covered by a lint fixture or `RuleTester`).
- [ ] CI job for `test:csp` exists, uses SHA-pinned actions, no caches.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- If C-04 does not export `ENGINE_UI_CSP`, the engine API prefix, the sign-in path and an in-memory client, add them to `packages/engine-api` in a separate PR first rather than defining them in engine-ui.
- Paths the UI owns versus paths the engine reserves (API prefix, `/sign-in`, `/setup`, `/.well-known/*`) must be listed in the contract so the loader's SPA fallback (M-05) does not shadow engine routes.
- Trusted Types are enforced only in Chromium-based browsers today; other engines still get the CSP. Flag if a dependency needs a policy name beyond `ptbk-html`.
