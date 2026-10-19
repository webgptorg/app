# D-01. Dashboard scaffold: Vite SPA and Hono API on Workers, D1, environments

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** —
- **Status:** todo
- **Spec:** Hosting and stack; One address for users; What our platform can and cannot do; Enterprise-ready engine architecture; ADRs: [0001](../../adr/0001-bun-workspaces-monorepo.md), [0005](../../adr/0005-modular-architecture.md), [0006](../../adr/0006-organizations-and-roles.md), [0007](../../adr/0007-frontend-stack.md), [0008](../../adr/0008-hono-for-http-apis.md), [0009](../../adr/0009-drizzle-and-migrations.md)

## Goal

`apps/dashboard` builds, runs locally and tests as one Cloudflare Worker that serves a Vite single-page app and a Hono API, with D1 through Drizzle and generated, CI-guarded migrations, in three environments (dev, staging, production), with the ports-and-adapters skeleton, the organization tenancy model with one `Authorizer` policy port, and English and Czech i18n that every later D task builds on.

## Context

app.ptbk.io is the entry point: account, engine list, billing, status. It links to engines and never loads their data or stores their content (AGENTS.md rule 2; docs/security.md, "Our domains never load engine data"). It also serves three machine APIs (registration, registry, heartbeat) that later tasks add. Per ADR 0006, an `Organization` owns engines and billing, users join through a `Membership` with a role, and all authorization goes through one policy port. v0 only creates personal organizations with one `owner`, but the model must take multi-user orgs later without moving ownership. The team prefers Cloudflare over Vercel.

The dashboard is a client-rendered SPA behind a sign-in (ADR 0007): the Worker serves static assets and the API, and renders nothing on the server. Every piece of data crosses an explicit HTTP endpoint declared with zod (ADR 0008). The database schema is TypeScript and migrations are generated, never hand-written (ADR 0009). This task builds only the scaffold; components from `@ptbk/ui` (U-02) arrive with the first screens, D-09 (D-02 is API only).

D-01 is large and may land as several PRs (for example toolchain and Worker shell, then D1 and migration guards, then i18n and the SPA shell); each PR references D-01, and the Status becomes `done (#<last PR>)` with the last one.

## Scope

- Stack, exact versions, each at least 7 days old (verified 2026-10-19): `vite` 8.3.4, `@vitejs/plugin-react` 6.1.2, `@cloudflare/vite-plugin` 1.63.1, `wrangler` 4.149.0 (dev dependency; the Vite plugin pins wrangler exactly, and 4.150 is too new for the 7-day rule, so keep both in step), `react`, `react-dom`, `@types/react` and `@types/react-dom` 19.3.0, `@tanstack/react-router` 1.170.42 with `@tanstack/router-plugin` 1.168.43 (file-based routes, automatic code splitting), `@tanstack/react-query` 5.104.2, `tailwindcss` and `@tailwindcss/vite` 4.3.3, `@inlang/paraglide-js` 2.27.0, `hono` 4.13.13, `drizzle-orm` 0.45.4 and `drizzle-kit` 0.31.11. TanStack Table, Virtual, Form and `@ptbk/ui` come with D-09; the scaffold's shell is plain Tailwind markup.
- Shared runtime versions come from the Bun workspace catalog in the root `package.json` (`"zod": "catalog:"`, zod 4.6.6 already there; `"react": "catalog:"` and so on). Add each new dependency that another package also uses (react, react-dom, their types, TanStack packages, Tailwind, Paraglide, hono) to the catalog rather than pinning it locally. Vitest is the repo-wide root devDependency 4.1.11; add `@cloudflare/vitest-pool-workers` 0.23.0, which supports it.
- Install scripts: esbuild, workerd and sharp (pulled in by Vite, wrangler and the Cloudflare plugin) are already approved in the root `trustedDependencies`; do not stop for them. Any other package that needs an install script is a separate, human-approved PR.
- Remove the placeholder `apps/dashboard/src/index.ts`.
- TypeScript, split by runtime: `tsconfig.json` holds only `references`; `tsconfig.client.json` covers `src/client/**` and `src/shared/**` with DOM libs, `jsx: "react-jsx"` and `types: ["vite/client"]`; `tsconfig.worker.json` covers the Worker side (`src/worker.ts`, `src/app/**`, `src/domain/**`, `src/adapters/**`, `src/shared/**`) with the wrangler-generated `worker-configuration.d.ts` and no DOM; `tsconfig.node.json` covers `vite.config.ts` and `drizzle.config.ts`. The package `typecheck` script runs all of them (`tsc -b`).
- `wrangler.jsonc`: `main: "src/worker.ts"`, `compatibility_flags: ["nodejs_compat"]`, D1 binding `DB` with `migrations_dir: "migrations"`, `observability` on, and Workers static assets (binding `ASSETS`, `not_found_handling: "single-page-application"`; the Vite plugin supplies the build directory). `run_worker_first` covers `/api/*`, `/v1/*`, `/internal/*` and `/webhooks/*`, plus every other path except Vite's fingerprinted files (`"!/assets/*"`), because the Worker sets the security headers on the HTML shell (see Risks). Top level is dev (local only); `env.staging` and `env.production` have their own D1 database, vars and routes as placeholders (`<staging-d1-id>`, `app.staging.<placeholder>`); I-02 fills them in.
- `src/worker.ts` (default export required by Workers): the default export is the Hono app's handler (`{ fetch: app.fetch }`, plus `scheduled` once I-04 adds Cron Triggers and the `scheduled` dispatcher); D-05 adds the Durable Object class as a named export. The Hono app is built in `src/app/http/` and mounts four routers: `/api` (the SPA's own UI API, session-authenticated from D-02), `/v1` (engines), `/internal` (relays), `/webhooks` (Stripe). A final GET/HEAD handler forwards to `env.ASSETS.fetch` (which returns `index.html` for deep links) and adds the headers. An unknown path under any of the four prefixes is a 404 problem+json, never `index.html`.
- Routes are declared from zod schemas and validated before the handler runs (`@hono/zod-validator` or an equivalent few lines): machine contracts come from `@ptbk/protocol` and stay framework-agnostic, Hono only binds them; the UI API's contracts live in `src/shared/api/` as a route table (method, path, params, body, response, error codes). Errors are RFC 9457 problem+json with a stable `code` (ADR 0008).
- Typed client for `/api/*`: a small fetch client in `src/client/api/` generated from the `src/shared/api/` route table, not Hono's RPC client `hc` (reasoning in Design notes). It parses every response with the contract's schema and returns the operation's outcome union. TanStack Query hooks wrap it; components never call `fetch`.
- Database, `src/adapters/db/`: `schema.ts`, `client.ts` (`drizzle(env.DB)`, built in the composition root), `drizzle.config.ts` at the app root (`dialect: "sqlite"`, `schema: "./src/adapters/db/schema.ts"`, `out: "./migrations"`). drizzle-kit generates the first migration from these tables:

  ```ts
  export const organizations = sqliteTable(
    'organizations',
    {
      id: text('id').primaryKey(),
      kind: text('kind', { enum: ['personal', 'team'] }).notNull(),
      name: text('name'),
      createdAt: integer('created_at').notNull(),
    },
    (t) => [check('organizations_kind_check', sql`${t.kind} in ('personal', 'team')`)],
  );

  export const users = sqliteTable('users', {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    emailVerifiedAt: integer('email_verified_at'),
    locale: text('locale').notNull().default('en'),
    platformRole: text('platform_role').notNull().default('none'),
    recoveredAt: integer('recovered_at'),
    createdAt: integer('created_at').notNull(),
  });

  export const memberships = sqliteTable(
    'memberships',
    {
      orgId: text('org_id')
        .notNull()
        .references(() => organizations.id),
      userId: text('user_id')
        .notNull()
        .references(() => users.id),
      role: text('role').notNull(),
      createdAt: integer('created_at').notNull(),
    },
    (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
  );
  ```

  No CHECK on `role` or `platform_role`: changing a CHECK makes SQLite rebuild the table. The adapter's zod schemas allow `role = 'owner'` and `platform_role = 'none' | 'admin'` now and grow later.

- Migration workflow: `db:generate` runs `drizzle-kit generate`; output (`migrations/NNNN_<name>.sql` plus `migrations/meta/`) is committed and reviewed; `wrangler d1 migrations apply DB` applies it (`--local` in dev, staging and production through I-03). Nobody runs `drizzle-kit push` or `migrate`, and nobody hand-writes migration SQL except data backfills, which get their own reviewed migration (`drizzle-kit generate --custom`).
- CI guards, extended by later tasks. They run from the dashboard's `test` script (which runs `db:check` first), which root `bun run check` reaches, so `bun run check`, and therefore CI, runs them; nothing here is a separate CI step:
  - **Drift:** `drizzle-kit generate` (and `drizzle-kit check`) on a clean tree must produce no file; a schema change without its generated migration fails.
  - **Destructive changes:** a script scans every file in `migrations/` for `DROP TABLE`, `DROP COLUMN`, any `RENAME`, and drizzle-kit's SQLite table rebuild (`__new_` tables, `PRAGMA foreign_keys=OFF`). Such a file fails unless its first line is `-- contract: <what is removed>; unused since <migration or PR>`. A marker comment rather than a PR label, because it is versioned next to the SQL, visible in review and history, and the check runs locally and in CI without the GitHub API. The marker is the only hand edit allowed in a generated file; it changes no SQL. Reviewers check that the contract step follows the expand/contract rule.
  - **Content allowlist:** `src/adapters/db/schema-allowlist.test.ts` lists every table and column of a D1 database after all migrations against a checked-in allowlist, so a new column is a visible review point for "no engine content".
- Branded IDs `OrgId`, `UserId`; `OrgRole` and `PlatformRole` unions.
- `Authorizer` port in `src/domain/authz/`: `can(actor, action, resource) → { kind: 'allowed' } | { kind: 'denied', reason: 'not-member' | 'role' | 'recovery-cooldown' | 'platform-admin-only' }`, where `actor = { userId, orgId, orgRole, platformRole, recoveredAt }` and `resource = { kind: 'org', orgId } | { kind: 'engine', orgId, engineId } | { kind: 'platform' }`. One policy table maps each action to allowed org roles, a `platformAdminOnly` flag and a `sensitive` flag; sensitive actions are denied with `recovery-cooldown` for 72 h after `recoveredAt` (D-02 sets it). Start with `org.read`; each later task adds its actions to the table. The policy takes a `Clock`.
- Config: `src/app/config.ts` parses bindings with a strict zod schema into a frozen `DashboardConfig` (`environment`, `dashboardOrigin`, `engineDomain`, `relays`). Nothing else reads `env`. `relays` is a JSON var per environment holding a non-empty list of `{ relayId, region }`, where `relayId` is the relay's hostname (the protocol `Hostname` schema, the same value as the relay's `RELAY_HOSTNAME`) and `region` a short lowercase label such as `eu-central`; registration returns the `relayId`s in order (D-03).
- Ports `Clock`, `Random`, `Logger` with system adapters and in-memory fakes.
- i18n with Paraglide JS 2, the same library engine-ui uses (messages compiled at build time, typed message functions, no eval): catalogues `messages/en.json` and `messages/cs.json`, compiled output in `src/paraglide/` generated (by the Vite plugin during dev and build, and by the `generate` script) and not committed. In the SPA the locale comes from the `ptbk_locale` cookie, then the browser's preferred languages, then `en`; once signed in, the user's `locale` (served by D-02's session endpoint) wins and is written to the cookie. The Worker uses the same compiled messages for what it renders itself (emails from D-02 on) through `resolveRequestLocale`: user's `locale`, cookie, `Accept-Language`, `en`. `<html lang>` follows the active locale; a language switcher sits in the shell. Dates and numbers through `Intl`. A lint rule forbids literal user-facing strings in `src/client/**`: `no-restricted-syntax` on `JSXText` nodes containing a letter (selector `JSXText[value=/\p{L}/u]`), scoped to `src/client/**/*.tsx` and excluding tests; no extra ESLint plugin.
- `GET /v1/health` → `{ "ok": true, "environment": "<env>" }`, `Cache-Control: no-store`.
- Security headers, set by the Worker on every response it serves, the HTML shell included: CSP `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'; trusted-types 'none'`, HSTS, `Referrer-Policy: no-referrer`, `nosniff`, COOP `same-origin`. No nonces: the built `index.html` has no inline script or style. `/api/*` responses are `Cache-Control: no-store`. `connect-src 'self'` makes "the dashboard never fetches engine data" browser-enforced.
- Per-route bundle budgets (ADR 0007): a check over Vite's build manifest fails when the entry chunk or a route chunk exceeds its budget in `bundle-budgets.json`.
- Tests: Vitest projects `unit` (Node pool, domain with fakes), `workers` (`@cloudflare/vitest-pool-workers` 0.23, the generated migrations applied with `readD1Migrations`/`applyD1Migrations`) and `client` (component tests with Testing Library against fake API clients).
- Local and containerized dev with TLS, because passkeys need a secure context on a real hostname and X-05 runs the dashboard in its compose stack: `apps/dashboard/Dockerfile.dev` builds the app and runs the built SPA and Worker in workerd (`vite preview` through the Cloudflare plugin, local D1 with migrations applied at start, local Durable Objects), serving HTTPS with a certificate and key passed in by path (the e2e dev CA from X-01/M-02, or a locally generated one), on a configurable hostname such as `app.ptbk.test`. `dashboardOrigin` and the WebAuthn rpID follow that hostname through config.
- Adapter selection in config: `adapters: { email: 'cloudflare' | 'fake', billing: 'stripe' | 'fake', rateLimit: 'workers' | 'memory' }`. The config schema rejects any `fake` or `memory` value unless `environment` is `dev`, so a staging or production deploy cannot run on fakes.
- Generated code is not committed. The dashboard's `generate` script compiles Paraglide messages, generates the TanStack Router route tree (`src/client/routeTree.gen.ts`) and runs `wrangler types` (`worker-configuration.d.ts`). Root `bun run generate` runs every package's `generate`, and root `bun run check` runs it before lint and typecheck; CI runs `bun run check` as one step. D-01 edits these root files and says so in the PR: `package.json` (the `generate` script and its place in `check`, if not there yet), `.gitignore` (the three generated outputs), `eslint.config.js` (ignores for `**/routeTree.gen.ts`, `**/worker-configuration.d.ts` and `apps/dashboard/src/paraglide/`, plus the dashboard rules below) and `.prettierignore` (`apps/dashboard/migrations/meta/`, drizzle-kit's JSON snapshots, plus the generated files).
- Scripts: `dev`, `dev:https`, `build`, `preview`, `generate`, `typecheck` (all four tsconfigs), `test` (`db:check`, then the Vitest projects, the destructive-guard tests, the bundle budget check and the build test over `dist/`, building first), `db:generate`, `db:migrate:local`, `db:check` (drift and destructive guards). Everything the acceptance criteria call a guard or a check is reachable from root `bun run check`. No deploy script (I-03). README updated: stack, layout, the API client choice, the migration workflow and the expand/contract rule.

## Out of scope

- Signup, passkeys, sessions, recovery, `EmailSender` (D-02); engines (D-03); Durable Objects (D-05); Stripe (D-07); team orgs and invites (later).
- `@ptbk/ui` components, tables and forms (U-02, adopted in D-09).
- Real Cloudflare resources and DNS (I-02); deploy workflows (I-03).

## Design notes

- Layout:

  ```
  src/
    worker.ts     Workers entry: default export (Hono fetch, later scheduled), DO classes (D-05)
    domain/       Pure logic, types, ports
    adapters/     Port implementations; adapters/db/ is the only place that imports drizzle-orm
    app/          Composition root, config, Hono app and routers (app/http/)
    shared/api/   UI API contracts (zod route table) used by the Hono routes and the SPA client
    client/       The SPA: main.tsx, routes/ (TanStack Router file routes), features/, api/
  index.html
  messages/
  migrations/     drizzle-kit output, committed
  drizzle.config.ts
  ```

  Generated files (`src/client/routeTree.gen.ts`, `worker-configuration.d.ts`, `src/paraglide/`) are git-ignored and excluded from lint and format. File routes use `export const Route`.

- Boundaries (ESLint): `src/client/**` imports only `src/client`, `src/shared`, `@ptbk/ui` and `@ptbk/protocol`; Worker code (`src/worker.ts`, `src/app`, `src/domain`, `src/adapters`) never imports `src/client`; `drizzle-orm` only inside `src/adapters/db/**`; Drizzle's relational query API (`db.query.*`, `relations()`) is banned because it changes in 1.0. Domain code sees repository ports only. Every new `no-restricted-imports` block is built with the `restrictImports(...)` helper in `eslint.config.js`, so the base bans (`vm`) and the domain-purity rules are extended, never silently replaced by a later config block. The helper replaces a block's whole pattern list, so a dashboard block whose `files` overlap `apps/*/src/domain/**` repeats the domain-purity patterns; add a lint fixture test or a quick `eslint --print-config` check that `src/domain/` still rejects an adapter import.
- API client choice: a fetch client over the shared zod route table rather than `hc`. It keeps each HTTP contract explicit as data (method, path, status codes, error codes) in the same style as `engine-api`'s `EngineApiClient`, so both SPAs work the same way; it validates responses at runtime (`unknown` at boundaries); and it does not couple the SPA to the inferred type of the whole Hono app, which slows type-checking as the API grows and lets a server refactor change the client silently. Cost: the route table is written by hand, which is the point.
- Rule for every later task: org-owned repositories take `orgId` as the first argument and put it in every `where`; handlers call `Authorizer.can` and never compare role names. Each org-scoped adapter test includes "org B cannot read or change org A's rows".
- Auth in the SPA: route guards (`beforeLoad`) read the session through TanStack Query, and a 401 from `/api/*` sends the user to `/signin`. The HTML shell is public and holds no data, so guards are UX only: every `/api/*` handler authorizes on its own.
- Machine routes ignore cookies and return problem+json errors, never stack traces or input echoes.
- Migrations must work with the Worker that is currently deployed: add (expand), deploy code that uses it, remove (contract) in a later PR once nothing reads the old shape. Migration and deploy are not atomic, and `wrangler rollback` does not undo migrations.
- Durable Object classes (D-05 on) keep wrangler's migration tags in `wrangler.jsonc`; they are unrelated to drizzle-kit.

## Acceptance criteria

- [ ] `bun run --filter @ptbk/dashboard dev` serves the home page and `/v1/health` with a local D1; `build` works for `CLOUDFLARE_ENV=staging` and `production`.
- [ ] Workers tests: health 200 with `no-store`; `/` and a deep link such as `/engines/x` return the SPA shell with the full header set (CSP without `unsafe-inline` or `unsafe-eval`, with `require-trusted-types-for 'script'` and `frame-ancestors 'none'`; HSTS); unknown `/api/*` and `/v1/*` → 404 problem+json, not HTML. A build test asserts `index.html` has no inline `<script>` or `<style>`. Unit: config fails closed on a missing or unknown var.
- [ ] Authorizer unit tests: owner allowed on own org; non-member denied `not-member`; platform-only action denied for a normal user; sensitive action denied `recovery-cooldown` at 71 h 59 min after recovery and allowed at 72 h.
- [ ] i18n: a test fails if `messages/en.json` and `messages/cs.json` do not have exactly the same keys or any value is empty; the home page renders in Czech when the browser prefers `cs` and no cookie is set (client test); `resolveRequestLocale` honours user locale, cookie and `Accept-Language` in that order (unit); the literal-string lint rule is active.
- [ ] Migrations: `migrations/` holds only drizzle-kit output; the drift check passes on a clean tree and fails after a schema edit without `db:generate`; the destructive guard fails on fixture migrations with `DROP COLUMN`, a `RENAME` and a table rebuild, and passes when the `-- contract:` marker is present (tests of the guard script).
- [ ] The API client rejects a response that does not match its contract (client test); `drizzle-orm` imports outside `src/adapters/db/` and `db.query` usage fail lint.
- [ ] The dev container starts, serves `https://<dev hostname>/v1/health` with the supplied certificate, and config refuses `adapters.billing = 'fake'` with `environment = 'staging'` (unit test).
- [ ] Bundle budget check, build test, drift and destructive guards all run from root `bun run check` (no separate CI step).
- [ ] Generated files are git-ignored and absent from the tree; `bun run check` passes on a fresh clone because `generate` runs before lint and typecheck; ESLint and Prettier ignore them and `migrations/meta/`.
- [ ] `typecheck` runs the client, worker and node tsconfigs; the client project has no Workers types and the worker project has no DOM lib.
- [ ] Schema allowlist test passes; `domain/` has no platform or adapter imports.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<last PR>)`.

## Risks and open points

- `run_worker_first` with a negated pattern needs a recent wrangler. If 4.149.0 lacks it, use `run_worker_first: true` and forward assets explicitly. A static `_headers` file would take the headers away from the Worker; flag it rather than choosing it alone.
- `vite dev` injects React Refresh's inline preamble, which the strict CSP blocks. A dev-only relaxation is acceptable only when `environment = 'dev'` under the Vite dev server; the dev container and every CSP test run the built output with the production policy.
- If a dependency needs a Trusted Types policy, add one named policy and flag it in the PR instead of dropping `trusted-types 'none'`.
- Paraglide's Vite plugin must work with `@cloudflare/vite-plugin`; if they conflict, flag it rather than switching library alone.
- drizzle-kit's SQLite output sometimes rebuilds a table for what looks like a small change (a new CHECK, a changed default); the destructive guard catches it, and the fix is usually a different schema change, not a marker.
- Staging hostname and Cloudflare account layout are decided in I-02.
- If ADR 0006 and this brief differ, follow the ADR and note it in the PR.
