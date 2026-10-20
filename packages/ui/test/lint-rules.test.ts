import { join } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { packageDir } from './theme-sources.ts';

const repoRoot = join(packageDir, '..', '..');
/**
 * Only the rules under test, without type information: building the repo-wide TypeScript program is what makes
 * type-aware linting slow, and none of these rules needs it.
 */
const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
    ruleFilter: ({ ruleId }) => !ruleId.startsWith('@typescript-eslint/'),
});

/** Lints `code` as if it were the given existing file, so the type-aware parser finds its project. */
async function ruleIds(code: string, path: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: join(repoRoot, path) });
    return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

const UI_FILE = 'packages/ui/src/components/button/button.tsx';
const ENGINE_UI_FILE = 'apps/engine-ui/src/app/providers.tsx';

describe('@ptbk/ui lint rules', { timeout: 30_000 }, () => {
    it.each([
        ['@ptbk/engine-api', "import { ENGINE_UI_CSP } from '@ptbk/engine-api';\nexport const x = ENGINE_UI_CSP;\n"],
        [
            '@tanstack/react-router',
            "import { createLink } from '@tanstack/react-router';\nexport const x = createLink;\n",
        ],
        ['@tanstack/react-query', "import { useQuery } from '@tanstack/react-query';\nexport const x = useQuery;\n"],
        ['@ptbk/protocol', "import { PERMISSIONS } from '@ptbk/protocol';\nexport const x = PERMISSIONS;\n"],
        ['node:fs', "import { readFile } from 'node:fs';\nexport const x = readFile;\n"],
    ])('refuse an import of %s', async (_, code) => {
        expect(await ruleIds(code, UI_FILE)).toContain('no-restricted-imports');
    });

    it('refuse the CSP sinks engine-ui refuses', async () => {
        const code =
            'export const X = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n';
        expect(await ruleIds(code, UI_FILE)).toContain('no-restricted-syntax');
    });

    it.each([
        ['packages/ui', UI_FILE],
        ['apps/engine-ui', ENGINE_UI_FILE],
    ])('refuse user-visible JSX text in %s, but allow expressions and the allowlist', async (_, path) => {
        expect(await ruleIds('export const X = () => <p>Save changes</p>;\n', path)).toContain('no-restricted-syntax');
        expect(await ruleIds('export const X = ({ t }: { t: string }) => <p>{t} · 3</p>;\n', path)).toEqual([]);
        expect(await ruleIds('export const X = () => <p>Promptbook</p>;\n', path)).toEqual([]);
    });

    it('allow sample text in gallery entries and tests', async () => {
        const code = 'export const X = () => <p>Sample</p>;\n';
        expect(await ruleIds(code, 'packages/ui/src/components/button/button.gallery.tsx')).toEqual([]);
        expect(await ruleIds(code, 'packages/ui/src/components/button/button.test.tsx')).toEqual([]);
    });
});
