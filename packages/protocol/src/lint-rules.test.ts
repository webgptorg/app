import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Lints snippets as if they were a file of this package, with the repository's real config.
const repoRoot = decodeURIComponent(new URL('../../../', import.meta.url).pathname);
const filePath = `${repoRoot}packages/protocol/src/random.ts`;

async function ruleIds(code: string): Promise<(string | null)[]> {
    const [result] = await new ESLint({ cwd: repoRoot }).lintText(code, { filePath });
    return result?.messages.map(({ ruleId }) => ruleId) ?? [];
}

describe('ESLint rules for the contract packages', () => {
    it.each([
        ['Math.random', 'export const value = Math.random();\n', 'no-restricted-properties'],
        ['window', 'export const value = window.location.href;\n', 'no-restricted-globals'],
        ['document', 'export const value = document.cookie;\n', 'no-restricted-globals'],
        ['localStorage', "export const value = localStorage.getItem('k');\n", 'no-restricted-globals'],
        ['node: imports', "export { randomBytes } from 'node:crypto';\n", 'no-restricted-imports'],
        ['cloudflare: imports', "export { env } from 'cloudflare:workers';\n", 'no-restricted-imports'],
        ['@ptbk/* imports', "export { Button } from '@ptbk/ui';\n", 'no-restricted-imports'],
    ])('rejects %s', async (_, code, rule) => {
        expect(await ruleIds(code)).toContain(rule);
    });

    it('accepts crypto.getRandomValues', async () => {
        expect(await ruleIds('export const value = crypto.getRandomValues(new Uint8Array(1));\n')).toEqual([]);
    });
}, 30_000);
