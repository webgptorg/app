# 0007. One frontend stack: Vite SPAs on TanStack, shared design system

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

We have two frontends: engine-ui (a static bundle the engine serves under a strict CSP, [ADR 0003](0003-ui-as-signed-bundle.md)) and the dashboard at app.ptbk.io. The spec first proposed TanStack Start for the dashboard. Both apps are behind a sign-in, neither needs SEO, and we want them to look and behave the same.

## Decision

- Both apps are **Vite single-page apps**: React, **TanStack Router** (file-based, code-split, typed search params so every view is linkable), **TanStack Query** (server state, prefetch on intent, optimistic updates with rollback), **TanStack Table** with TanStack Virtual for every tabular view, Tailwind 4 (CSS at build time only), **Paraglide JS 2** for i18n (English and Czech, compiled at build time).
- A private **`packages/ui`** holds the design system both apps use: tokens, accessible components, form primitives, `DataTable`, i18n helpers. It is CSP-safe by construction and imports no app or contract package.
- No server-side rendering for now. TanStack Start may be adopted later for public pages only; it builds on the same Router, so that is incremental. APIs never move into Start server functions ([ADR 0008](0008-hono-for-http-apis.md)).
- UX bar for every view: loading skeletons, empty and error states, route-level error boundaries, toasts for async outcomes, keyboard and focus management, WCAG 2.2 AA, responsive to 360 px, reduced motion respected, per-route bundle budgets in CI.

## Consequences

- One set of components, patterns and tests for both apps; a fix in `packages/ui` lands in both.
- No SSR attack surface or server rendering cost; the dashboard Worker serves static assets plus the API.
- First paint waits for the JavaScript bundle; acceptable behind a login, and route splitting plus prefetching keep it fast.
