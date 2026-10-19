# 0009. Drizzle for D1, with generated and guarded migrations

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

The dashboard stores accounts, organizations, the engine registry, heartbeat metadata and billing state in Cloudflare D1 (SQLite). Hand-written migrations are error-prone; we want typed queries, reviewable migrations, and safety against breaking a live deployment or storing engine content by accident.

## Decision

- **Drizzle ORM 0.45.x** (stable) with **drizzle-kit 0.31.x**. The schema is TypeScript in `apps/dashboard/src/adapters/db/schema.ts`; drizzle-kit generates SQL migrations into `migrations/`; they are committed, reviewed and applied with `wrangler d1 migrations apply` (local, staging, production in that order, production after approval).
- Only Drizzle's core query builder is used. The relational query API is avoided until Drizzle 1.0 settles it.
- Drizzle lives only in `src/adapters/db/`. Domain code depends on repository ports, so the ORM is replaceable.
- Data backfills are separate, reviewed migrations (`drizzle-kit generate --custom`). Generated schema migrations are not hand-edited, with one exception: a contract step carries a `-- contract: <reason>` marker on its first line, which the destructive-change guard requires.
- **Expand, deploy, contract.** Migration and deploy are not atomic, so every migration must work with the Worker that is currently live. Removing or renaming happens in a later PR, after the code no longer uses the old shape.
- **CI guards:**
  1. Drift: `drizzle-kit generate` on a clean tree must produce nothing.
  2. Destructive changes: a migration with `DROP`, a rename or an SQLite table rebuild fails CI unless the migration carries the `-- contract:` marker.
  3. Content allowlist: a test lists every table and column against a checked-in allowlist, so a new column is an explicit review point for "the dashboard stores no engine content".
- Durable Objects keep wrangler's own migration tags.

## Consequences

- Typed schema and queries from one source; migrations are generated, small and reviewable.
- SQLite cannot alter some things in place, so drizzle-kit sometimes generates a table rebuild; the destructive-change guard makes those deliberate.
- Moving to Drizzle 1.0 later is a contained adapter change.
