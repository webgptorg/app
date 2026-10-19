import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { inject } from 'vitest';

declare module 'vitest' {
    interface ProvidedContext {
        migrations: D1Migration[];
    }
}

// The committed drizzle-kit output, applied the way `wrangler d1 migrations apply` does.
await applyD1Migrations(env.DB, inject('migrations'));
