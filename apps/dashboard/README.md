# @ptbk/dashboard

app.ptbk.io: account sign-up with passkeys, engine list, billing (Stripe), engine status, and links to engines. Also the HTTP API engines and relays talk to:

- `POST /v1/engines/register`: engine registration (spec, Interfaces 1; D-03)
- `GET /internal/v1/engines/{engineId}`: registry lookup for relays, relay-key authenticated (Interfaces 2; D-04)
- `POST /v1/engines/{engineId}/heartbeat`: signed heartbeat (Interfaces 4; D-05)
- `GET /v1/health`: `{ "ok": true, "environment": "<env>" }`, never cached

It stores no engine content, not even encrypted (AGENTS.md rule 2), and no page of it loads anything from an engine hostname: the CSP's `connect-src 'self'` and `frame-src 'none'` enforce that in the browser.

## Stack

One Cloudflare Worker serves a Vite single-page app and a Hono API ([ADR 0007](../../docs/adr/0007-frontend-stack.md), [ADR 0008](../../docs/adr/0008-hono-for-http-apis.md)). React with TanStack Router (file routes, code-split) and Query, Tailwind 4 with `@ptbk/ui` (tokens, components, forms, `DataTable`), Paraglide JS 2 for English and Czech. D1 through Drizzle with generated, guarded migrations ([ADR 0009](../../docs/adr/0009-drizzle-and-migrations.md)). Durable Objects (D-05) and Cron Triggers (I-04) come later.

The Worker renders nothing on the server. Every request except Vite's fingerprinted `/assets/*` runs the Worker first (`run_worker_first`), so the security headers (strict CSP with Trusted Types, HSTS, `no-referrer`, `nosniff`, COOP) are set on the HTML shell too. Under `vite dev` only, and only in `dev`, the CSP allows React Refresh's inline preamble and HSTS is left out; builds, the dev container and every test use the production policy. The SPA sets zod to `jitless` before any schema exists, because zod's `new Function` probe is a reported Trusted Types violation even though it is caught.

## Layout

```
src/
  worker.ts     Workers entry: default export { fetch }; Durable Object classes from D-05
  domain/       Pure logic, types and ports (Clock, Random, Logger, Authorizer). No I/O, no platform imports
  adapters/     Port implementations and in-memory fakes; adapters/db/ is the only place that imports drizzle-orm
  app/          Composition root (create-dashboard.ts), config, i18n for what the Worker renders, Hono app in app/http/
  shared/api/   The UI API: a zod route table used by both the Hono routes and the SPA client
  testing/      Fakes, the software WebAuthn authenticator and shared contract suites; never shipped
  client/       The SPA: main.tsx, routes/ (TanStack Router file routes), features/, core/ (shell plumbing), api/, i18n/
messages/       en.json and cs.json, the only place user-facing text lives
migrations/     drizzle-kit output, committed
scripts/        Migration guards, bundle budget check, dev container entry point
test/           Build output, catalogues, lint rules; test/http/ runs the HTTP app with real adapters (route table, auth flows)
```

ESLint keeps the boundaries: the SPA imports only `src/client`, `src/shared`, the generated messages, `@ptbk/ui` and `@ptbk/protocol`; Worker code never imports the SPA; `drizzle-orm` only inside `src/adapters/db/`, where Drizzle's relational query API (`db.query`, `relations`) is banned until Drizzle 1.0.

The Hono app mounts four routers: `/api` (the SPA's own API), `/v1` (engines), `/internal` (relays) and `/webhooks` (Stripe). Machine routes bind contracts from `@ptbk/protocol`; the UI API's contracts live in `src/shared/api/routes.ts`. Every error is RFC 9457 `application/problem+json` with a stable `code`, never a stack trace or an echo of the input; a 500 carries a `correlationId` that is also logged. An unknown path under one of the four prefixes is a 404 problem, never the SPA shell.

### Routes

Every route is a `defineRoute` contract (`src/shared/api/contract.ts`) mounted with the route binder (`src/app/http/bind-route.ts`), which refuses anything without a safeguard ([engineering.md](../../docs/engineering.md#request-handling-every-http-endpoint)). A contract declares `auth` (`public` or `session`, no default), a `permission` from `DASHBOARD_POLICY` for session routes, a per-IP `rateLimit` for every non-session route, strict `input` schemas (params, query, the headers it reads, body) with a body size cap, and a strict `output`. Per request the binder applies, in order: the rate limit (429, also when the limiter cannot decide), the body cap (413), input validation (400), the session (401), then `Authorizer.can` on the actor's own scope (404 for what is not theirs, 403 with `step-up-required` or `recovery-cooldown`, else 403). `test/http/route-table.test.ts` enumerates the mounted Hono routes, fails on any route that bypassed the binder, and holds the allowlist of `public` routes. State-changing `/api` requests also pass the Fetch Metadata check (`Sec-Fetch-Site: same-origin`, else `Origin` equal to `DASHBOARD_ORIGIN`); machine routes never read cookies.

### Accounts, sessions, passkeys (D-02)

- **Signup is email first:** `signup/start` always answers 202 with the same body and mails a 15-minute link (`/signup#<token>`) or, for a known address, an "account exists" note; the lookup and the mail run after the response (`waitUntil`). `signup/options` and `signup/verify` register a passkey and create user, personal org, owner membership, passkey and session in one D1 batch.
- **Sign-in** is usernameless with discoverable passkeys; the returned `userHandle` must be the credential owner's random `webauthn_user_id`. User verification is always required; rpID and origin come from `DASHBOARD_ORIGIN`. A signature counter that does not grow from a non-zero value sets `counter_regressed_at`, logs `auth.passkey-counter-regression` with the user ID only, and fails the sign-in.
- **Challenges** are single use (deleted in the statement that reads them), live 5 minutes, are bound to the browser by `__Host-ptbk_chal` and, in token flows, to the email token's hash.
- **Sessions:** `__Host-ptbk_session` (`Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax` so links from emails arrive signed in), 256-bit random, stored as SHA-256, new ID on every sign-in, idle 7 days, absolute 30 days, read on every request. A sign-in counts as a 5-minute step-up; `step-up/options` and `step-up/verify` renew it for actions with `requiresStepUp`.
- **Recovery:** `recovery/request` answers like `signup/start`; the link only allows `recovery/options` and `recovery/verify`, which add a passkey, revoke every session, set `recovered_at` (72-hour cooldown for `sensitive` actions) and mail a notice. Email tokens are 256-bit, stored as SHA-256, single use, 15 minutes, and a newer one replaces older ones.
- **Rate limits** (`RATE_LIMITS` in `src/domain/ports/rate-limiter.ts`): per-minute rules run on the Workers Rate Limiting binding (one binding per rule in `wrangler.jsonc`, checked against the code by a test); the hourly signup and recovery rules run on the `HourlyRateLimiter` Durable Object, because the binding only has 10 s and 60 s periods. Production keys are `HMAC-SHA-256(RATE_LIMIT_HMAC_KEY, rule ‖ IP or email)`, so no raw IP or address is stored; a counter is deleted when its window ends; a limiter error fails closed.
- **Email** goes through the `EmailSender` port: Cloudflare Email Service (`send_email` binding `EMAIL`, sender `EMAIL_FROM`), or in dev the fake outbox that `GET /api/__dev/emails?to=` returns for e2e. Templates are plain text in `messages/*.json`.
- **Platform admins:** `platform_role = 'admin'` is set by hand ([scripts/make-admin.md](scripts/make-admin.md)); admin actions need a fresh step-up and write `admin_audit_log`.

Config is parsed once in `src/app/config.ts` into a frozen `DashboardConfig`; nothing else reads `env`. It fails closed on a missing var, an unknown var or an unknown value, and refuses `fake` or `memory` adapters outside `dev`. Runtime objects in `env` (D1, ASSETS, service bindings) are wired by the composition root, not parsed as config.

### Tenancy and authorization

An organization owns engines and billing; users join through a membership with a role ([ADR 0006](../../docs/adr/0006-organizations-and-roles.md)). Every authorization decision goes through `Authorizer.can(actor, action, resource)` in `src/domain/authz/`, deny by default, with one policy table in `policy.ts`. Rules for every later task:

- Add the action to `DASHBOARD_POLICY`; handlers and components check actions, never role names.
- Org-owned repositories take `orgId` as the first argument and put it in every `where`. Each org-scoped adapter test includes "org B cannot read or change org A's rows".
- Timestamps are integers in milliseconds since the Unix epoch.

### SPA: screens, guards, passkeys (D-09)

- **Routes.** `_app` is the signed-in layout (`/`, `/account`, `/admin`): its guard reads `GET /api/session` through TanStack Query and sends anyone without a session to `/signin?returnTo=…`; `returnTo` only ever holds a same-origin path (`safeReturnTo`). `_auth` is the signed-out frame; under it `_guest` (`/signin`, `/signup`) sends a signed-in person home, while `/recover` stays open. `/admin` answers "not found" unless `platformRole` is `admin`. A 401 on any later call clears the cache and returns to sign-in.
- **Shell** from `@ptbk/ui`: skip link, org name, navigation by the session's org permissions (`features/shell/navigation.ts`, never role names; `/admin` by the platform role), the user menu (language, theme, sign out), route-level error, pending and not-found states.
- **Emailed tokens** (`/signup#…`, `/recover#…`): the route's `beforeLoad` moves the fragment into an in-memory holder and replaces the URL without it before anything renders; the page takes it into its state. It is never in history, storage or a later URL (`test:csp` checks).
- **Passkeys** go through the `PasskeyAuthenticator` port (`features/passkeys/`): `@simplewebauthn/browser` in the app, a fake in tests. Its output is narrowed to the API's schemas, so an unrequested extension result never makes a strict server refuse it. `classifyPasskeyError` is the one table from browser errors to reasons (cancelled, not allowed, no authenticator, already registered, unsupported), and `ceremony-messages.ts` the one place they become words; every screen shows them with a retry.
- **Mutations** use `useAppMutation`: a `step-up-required` answer opens the step-up dialog (passkey assertion in place) and retries, failures become toasts (`recovery-cooldown` with its end), nothing is optimistic (adding a passkey needs the authenticator; removal and "sign out everywhere" must not pretend).
- The API stores no passkey name, so `/account` names a passkey by the end of its credential ID and shows where it lives from `backedUp` (synced or one device).

### API client

The SPA calls `/api/*` only through `src/client/api/api-client.ts`, a small fetch client over the shared route table, wrapped in TanStack Query hooks; components never call `fetch`. It parses every response with the contract's schema, tolerantly: fields the contract does not know are dropped at any depth, known ones are fully validated (AGENTS.md rule 5). It returns an outcome union (`ok`, `problem` with a declared code, `invalid-response`, `network-error`). Output schemas stay strict, and the HTTP tests parse every response with them, so the server never sends an undeclared field.

We chose this over Hono's RPC client `hc`: each HTTP contract stays explicit as data (method, path, schemas, error codes), the same style as `engine-api`'s `EngineApiClient`; responses are validated at runtime, not just typed; and the SPA does not depend on the inferred type of the whole Hono app, which slows type-checking as the API grows and lets a server refactor change the client silently. The cost is writing the route table by hand, which is the point.

### i18n

Paraglide compiles `messages/*.json` into typed functions at build time (no runtime parser, no eval); its message-format plugin is loaded from `node_modules`, never from a CDN. The SPA picks the locale from the `ptbk_locale` cookie, then the browser's languages, then English; signing in or signing up applies the account's saved locale and writes it to the cookie (recovery keeps the language it was done in). `<html lang>` follows the locale; language and theme sit in the user menu, and in a preferences menu on the signed-out pages. `@ptbk/ui`'s strings come from the same catalogues (`core/ui-messages.ts`). What the Worker renders itself (emails from D-02) uses `resolveRequestLocale`: user locale, cookie, `Accept-Language`, English. ESLint rejects literal text in `src/client/**/*.tsx`, and any HTML sink or string `style` attribute in `src/client` (the CSP has `trusted-types 'none'`).

## Commands

| Command                    | What it does                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`              | Applies migrations to the local D1, then `vite dev` with the Worker in workerd                                                                                                                                                                                  |
| `bun run dev:https`        | The same over HTTPS on a real hostname, for passkeys (see below)                                                                                                                                                                                                |
| `bun run build`            | Builds SPA and Worker; `CLOUDFLARE_ENV=staging` or `production` builds that environment                                                                                                                                                                         |
| `bun run preview`          | Serves the build in workerd with the production CSP                                                                                                                                                                                                             |
| `bun run generate`         | Paraglide messages, the route tree and `wrangler types`; generated files are never committed                                                                                                                                                                    |
| `bun run typecheck`        | `tsc -b` over the client (DOM, no Workers types), worker (Workers types, no DOM) and node projects                                                                                                                                                              |
| `bun run test:csp`         | Builds, then Playwright in Chromium against `vite preview` (production CSP, fresh local D1, fake outbox) on `http://localhost:4174`: the D-09 flows with a virtual WebAuthn authenticator, axe and 360 px on every screen, zero CSP or Trusted Types violations |
| `bun run test`             | `db:check`, build, the `unit` and `client` Vitest projects with coverage (≥ 90% lines and branches; `src/domain/**` and `config.ts` at 100%), the `workers` project, then the bundle budgets                                                                    |
| `bun run db:generate`      | `drizzle-kit generate`; pass `--name <what>` after a schema change                                                                                                                                                                                              |
| `bun run db:migrate:local` | `wrangler d1 migrations apply DB --local`                                                                                                                                                                                                                       |
| `bun run db:check`         | Migration guards: drizzle-kit output only, no drift, no unmarked destructive change                                                                                                                                                                             |

Root `bun run check` reaches all of it, so CI runs every guard. There is no deploy script; deploys come with I-03.

## Environments

`wrangler.jsonc`: the top level is local development only; `env.staging` and `env.production` have their own D1 database, vars and routes. Their values are placeholders until I-02. Vars: `ENVIRONMENT`, `DASHBOARD_ORIGIN`, `ENGINE_DOMAIN`, `RELAYS` (non-empty list of `{ relayId, region }`, `relayId` being the relay's hostname), `ADAPTERS` (`email`, `billing`, `rateLimit`) and `EMAIL_FROM`. Secret: `RATE_LIMIT_HMAC_KEY` (base64url, at least 256 bits; `wrangler secret put` in staging and production, a committed dev-only value that config refuses elsewhere). Bindings besides `DB` and `ASSETS`: `HOURLY_RATE_LIMITER` (Durable Object, migration tag `v1`), `RATE_LIMIT_OPTIONS`, `RATE_LIMIT_VERIFY`, `RATE_LIMIT_PUBLIC_READ`, and `EMAIL` (`send_email`, staging and production).

The compatibility date stays within what the workerd bundled with `@cloudflare/vitest-pool-workers` supports, so the Workers tests run the same date as production.

## Migrations

The schema is TypeScript in `src/adapters/db/schema.ts`. After changing it, run `bun run db:generate --name <what>` and commit the SQL and `migrations/meta/`. Nobody runs `drizzle-kit push` or `migrate`, and nobody writes schema SQL by hand; a data backfill is its own reviewed migration from `drizzle-kit generate --custom`. Migrations are applied with `wrangler d1 migrations apply DB` (`--local` here; staging and production through I-03).

**Expand, deploy, contract.** Migration and deploy are not atomic and `wrangler rollback` does not undo a migration, so every migration must work with the Worker that is live: add the new shape (expand), deploy code that uses it, and remove the old one (contract) in a later PR once nothing reads it.

`db:check` enforces:

- **Layout:** `migrations/` holds only files drizzle-kit journaled.
- **Drift:** `drizzle-kit check` and `drizzle-kit generate` on a copy of `migrations/` must produce nothing, so a schema change without its migration fails.
- **Destructive changes:** a migration with `DROP TABLE`, `DROP COLUMN`, any `RENAME` or a table rebuild (`__new_` tables, `PRAGMA foreign_keys=OFF`) fails unless its first line is `-- contract: <what is removed>; unused since <migration or PR>`. That marker is the only hand edit allowed in a generated file; reviewers check the contract step follows the rule above. If drizzle-kit rebuilds a table for what looks like a small change (a new CHECK, a changed default), prefer a different schema change over the marker.

`src/adapters/db/schema-allowlist.test.ts` compares every table and column after all migrations with a checked-in allowlist, so each new column is a visible review point for "no engine content".

## HTTPS development and the dev container

Passkeys need a secure context on a real hostname. Both modes take a certificate and key by path; for a local pair:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
  -subj "/CN=app.ptbk.test" -addext "subjectAltName=DNS:app.ptbk.test" -keyout key.pem -out cert.pem
```

`dev:https` runs `vite dev --mode https`; the Worker's `DASHBOARD_ORIGIN` (and so the WebAuthn rpID) follows the served origin:

```sh
DASHBOARD_ORIGIN=https://app.ptbk.test:5173 DASHBOARD_TLS_CERT=cert.pem DASHBOARD_TLS_KEY=key.pem bun run dev:https
```

`Dockerfile.dev` builds the app and runs the built SPA and Worker in workerd (`vite preview` through the Cloudflare plugin), with the committed migrations applied to a local D1 at start and the production CSP. The origin is set at start, so one image serves any dev hostname. X-05 runs it in the e2e stack:

```sh
docker build -f apps/dashboard/Dockerfile.dev -t ptbk-dashboard-dev .
docker run --rm -p 443:443 -v "$PWD/tls:/tls:ro" \
  -e DASHBOARD_ORIGIN=https://app.ptbk.test -e DASHBOARD_TLS_CERT=/tls/cert.pem -e DASHBOARD_TLS_KEY=/tls/key.pem \
  ptbk-dashboard-dev
```

## Bundle budgets

`bundle-budgets.json` caps the gzipped JavaScript of the entry (with its static imports) and of each route chunk; `scripts/check-bundle-budgets.ts` reads Vite's build manifest and fails the test run when one is over. A route that needs more gets its own entry under `routes`, keyed by its source file.
