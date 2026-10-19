import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/**
 * Every table and column the dashboard stores, after all migrations. A new column fails this test until it is added
 * here, so each one is a deliberate review point for "the dashboard stores no engine content" (AGENTS.md rule 2):
 * no prompts, messages, files or agent output, not even encrypted.
 */
const ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
    memberships: ['org_id', 'user_id', 'role', 'created_at'],
    organizations: ['id', 'kind', 'name', 'created_at'],
    users: ['id', 'email', 'email_verified_at', 'locale', 'platform_role', 'recovered_at', 'created_at'],
};

async function storedColumns(): Promise<Record<string, string[]>> {
    const tables = await env.DB.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();
    const out: Record<string, string[]> = {};
    for (const { name } of tables.results) {
        const columns = await env.DB.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').bind(name).all<{
            name: string;
        }>();
        out[name] = columns.results.map((column) => column.name);
    }
    return out;
}

describe('D1 schema', () => {
    it('matches the content allowlist exactly', async () => {
        expect(await storedColumns()).toEqual(ALLOWLIST);
    });
});
