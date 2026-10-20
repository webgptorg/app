import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const ROLE = '(owner|admin|member|viewer)';
/** `role === 'owner'`, `'admin' !== member.role`, `case 'viewer':` on a role, `roles.includes(...)` and friends. */
const ROLE_COMPARISONS = [
    new RegExp(`\\brole\\w*\\s*[!=]==?\\s*['"\`]${ROLE}['"\`]`, 'i'),
    new RegExp(`['"\`]${ROLE}['"\`]\\s*[!=]==?\\s*[\\w.?]*role\\b`, 'i'),
    new RegExp(`switch\\s*\\([\\w.?]*role\\w*\\)`, 'i'),
    new RegExp(`\\brole\\w*\\s*\\)?\\s*\\.\\s*(startsWith|includes|match)\\(`, 'i'),
];

function findRoleComparisons(text: string): string[] {
    return ROLE_COMPARISONS.flatMap((pattern) => text.match(pattern)?.[0] ?? []);
}

describe('engine-ui decides by permission, never by role', () => {
    it('has no role-name comparison in src/', async () => {
        const files = (await readdir(srcDir, { recursive: true })).filter(
            (file) => /\.tsx?$/.test(file) && !file.includes('paraglide') && !file.endsWith('role-comparisons.test.ts'),
        );
        const found: string[] = [];
        for (const file of files) {
            for (const match of findRoleComparisons(await readFile(join(srcDir, file), 'utf8'))) {
                found.push(`${file}: ${match}`);
            }
        }
        expect(found).toEqual([]);
    });

    it.each([
        "if (member.role === 'owner') {}",
        "const isAdmin = 'admin' === me.role;",
        'switch (member.roleLabel) {}',
        "roleLabel !== 'viewer'",
    ])('catches %s', (code) => {
        expect(findRoleComparisons(code)).not.toEqual([]);
    });

    it('allows displaying a role', () => {
        expect(findRoleComparisons('<span>{roleLabel(member.roleLabel)}</span>')).toEqual([]);
    });
});
