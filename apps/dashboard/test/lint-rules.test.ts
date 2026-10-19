import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const eslint = new ESLint({ cwd: repoRoot });

/**
 * Lints `code` as if it were the file at `path` (an existing file, so the type-aware parser finds its project) and
 * returns the boundary rules that fired. Proves the rules in eslint.config.js reach the files they are meant for.
 */
async function boundaryViolations(path: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: join(repoRoot, 'apps/dashboard', path) });
    return (result?.messages ?? [])
        .filter((message) => message.ruleId === 'no-restricted-imports' || message.ruleId === 'no-restricted-syntax')
        .map((message) => message.ruleId ?? '');
}

describe('dashboard lint rules', { timeout: 30_000 }, () => {
    it('forbid user-facing literals in SPA components', async () => {
        expect(await boundaryViolations('src/client/app.tsx', 'export const X = () => <p>Hello</p>;\n')).toEqual([
            'no-restricted-syntax',
        ]);
        expect(await boundaryViolations('src/client/app.tsx', 'export const X = () => <p>Ahoj světe</p>;\n')).toEqual([
            'no-restricted-syntax',
        ]);
        expect(await boundaryViolations('src/client/app.tsx', 'export const X = () => <p>{1} · 2</p>;\n')).toEqual([]);
    });

    it.each([
        ['src/client/app.tsx', "import { parseConfig } from '../app/config';\nexport const x = parseConfig;\n"],
        ['src/client/app.tsx', "import { Hono } from 'hono';\nexport const x = Hono;\n"],
        ['src/client/app.tsx', "import { sql } from 'drizzle-orm';\nexport const x = sql;\n"],
        ['src/app/config.ts', "import { sql } from 'drizzle-orm';\nexport const x = sql;\n"],
        ['src/app/config.ts', "import { App } from '../client/app';\nexport const x = App;\n"],
        ['src/app/config.ts', "import vm from 'node:vm';\nexport const x = vm;\n"],
        [
            'src/domain/ids.ts',
            "import { systemClock } from '../adapters/system-clock';\nexport const x = systemClock;\n",
        ],
        ['src/domain/ids.ts', "import { webcrypto } from 'node:crypto';\nexport const x = webcrypto;\n"],
        ['src/domain/ids.ts', "import { sql } from 'drizzle-orm';\nexport const x = sql;\n"],
        [
            'src/shared/api/routes.ts',
            "import { parseConfig } from '../../app/config';\nexport const x = parseConfig;\n",
        ],
        ['src/adapters/db/client.ts', "import { relations } from 'drizzle-orm';\nexport const x = relations;\n"],
        ['src/adapters/db/client.ts', "import vm from 'node:vm';\nexport const x = vm;\n"],
    ])('reject a boundary-crossing import in %s: %s', async (path, code) => {
        expect(await boundaryViolations(path, code)).not.toEqual([]);
    });

    it('ban the Drizzle relational query API', async () => {
        const code = "import type { Database } from './client';\nexport const f = (db: Database) => db.query;\n";
        expect(await boundaryViolations('src/adapters/db/schema.ts', code)).toEqual(['no-restricted-syntax']);
    });

    it('allow the core query builder inside src/adapters/db', async () => {
        const code = "import { eq } from 'drizzle-orm';\nexport const x = eq;\n";
        expect(await boundaryViolations('src/adapters/db/client.ts', code)).toEqual([]);
    });
});
