import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { checkDestructive, checkDrift, checkLayout } from './migration-guards.ts';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(appDir, 'migrations');
const schemaPath = join(appDir, 'src/adapters/db/schema.ts');
const fixture = (name: string) => readFile(join(appDir, 'scripts/fixtures/migrations', name), 'utf8');

const scratchDirs: string[] = [];
async function scratch(): Promise<string> {
    const root = join(appDir, 'node_modules', '.tmp');
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, 'guard-test-'));
    scratchDirs.push(dir);
    return dir;
}
afterEach(async () => {
    await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('destructive-change guard', () => {
    it.each([
        ['drop-column.sql', ['DROP COLUMN']],
        ['rename.sql', ['RENAME']],
        [
            'rebuild.sql',
            ['DROP TABLE', 'RENAME', 'table rebuild (__new_ table)', 'table rebuild (PRAGMA foreign_keys=OFF)'],
        ],
        ['drop-column-incomplete-marker.sql', ['DROP COLUMN']],
        ['drop-column-marker-not-first.sql', ['DROP COLUMN']],
    ])('fails %s without a valid first-line marker', async (name, findings) => {
        expect(checkDestructive(await fixture(name))).toEqual({ kind: 'destructive', findings });
    });

    it.each(['drop-column-with-marker.sql', 'rebuild-with-marker.sql'])('passes %s with the marker', async (name) => {
        expect(checkDestructive(await fixture(name)).kind).toBe('contract');
    });

    it('passes the committed migrations', async () => {
        expect(checkDestructive(await readFile(join(migrationsDir, '0000_init.sql'), 'utf8'))).toEqual({ kind: 'ok' });
    });
});

describe('layout guard', () => {
    it('accepts the committed migrations', async () => {
        expect(await checkLayout(migrationsDir)).toEqual([]);
    });

    it('rejects a hand-written SQL file that drizzle-kit did not journal', async () => {
        const dir = await scratch();
        await cp(migrationsDir, dir, { recursive: true });
        await writeFile(join(dir, '0001_hand_written.sql'), 'CREATE TABLE `prompts` (`body` text);\n');
        expect(await checkLayout(dir)).toEqual(['0001_hand_written.sql is not in meta/_journal.json']);
    });
});

describe('drift guard', { timeout: 30_000 }, () => {
    it('passes on the committed schema', async () => {
        expect(await checkDrift({ appDir, schemaPath, migrationsDir })).toEqual({ kind: 'clean' });
    });

    it('fails after a schema edit without db:generate', async () => {
        const dir = await scratch();
        const edited = (await readFile(schemaPath, 'utf8')).replace(
            "recoveredAt: integer('recovered_at'),",
            "recoveredAt: integer('recovered_at'),\n    nickname: text('nickname'),",
        );
        const editedSchema = join(dir, 'schema.ts');
        await writeFile(editedSchema, edited);
        const result = await checkDrift({ appDir, schemaPath: editedSchema, migrationsDir });
        expect(result.kind).toBe('drift');
    });
});
