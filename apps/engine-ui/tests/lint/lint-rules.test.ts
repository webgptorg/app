import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const eslint = new ESLint({ cwd: repoRoot });

/** Lints `code` as if it were an existing engine-ui file, so the type-aware parser finds its project. */
async function ruleIds(code: string, path = 'src/routes/agents/index.tsx'): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: join(repoRoot, 'apps/engine-ui', path) });
    return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

describe('engine-ui lint rules', { timeout: 30_000 }, () => {
    it.each([
        [
            'dangerouslySetInnerHTML',
            'export const X = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n',
        ],
        ['innerHTML', 'export const f = (el: Element, html: string) => {\n    el.innerHTML = html;\n};\n'],
        ['outerHTML', 'export const f = (el: Element) => el.outerHTML;\n'],
        ['computed innerHTML', "export const f = (el: Element, html: string) => {\n    el['innerHTML'] = html;\n};\n"],
        [
            'insertAdjacentHTML',
            "export const f = (el: Element, html: string) => {\n    el.insertAdjacentHTML('beforeend', html);\n};\n",
        ],
        ['document.write', "export const f = () => {\n    document.write('<p>x</p>');\n};\n"],
        [
            'a style attribute string',
            "export const f = (el: Element) => {\n    el.setAttribute('style', 'color: red');\n};\n",
        ],
        ['a worker from a string', "export const f = () => new Worker('/worker.js');\n"],
    ])('reject %s', async (_, code) => {
        expect(await ruleIds(code)).toContain('no-restricted-syntax');
    });

    it('allow React state, CSSOM styles and a bundled worker URL', async () => {
        const code =
            "export const X = () => <p style={{ color: 'red' }}>x</p>;\n" +
            "export const f = () => new Worker(new URL('./w.ts', import.meta.url), { type: 'module' });\n";
        expect(await ruleIds(code)).toEqual([]);
    });

    it('keep the HTML sink open only in src/security/trusted-html.ts', async () => {
        const config = (await eslint.calculateConfigForFile(
            join(repoRoot, 'apps/engine-ui/src/security/trusted-html.ts'),
        )) as { rules?: Record<string, unknown> };
        expect(JSON.stringify(config.rules?.['no-restricted-syntax'] ?? 'off')).not.toContain('innerHTML');
    });

    it('enforce the rules of hooks and accessible markup', async () => {
        const hooks =
            "import { useState } from 'react';\nexport const X = ({ on }: { on: boolean }) => {\n    if (on) useState(0);\n    return null;\n};\n";
        expect(await ruleIds(hooks)).toContain('react-hooks/rules-of-hooks');
        expect(await ruleIds('export const X = () => <img src="/a.png" />;\n')).toContain('jsx-a11y/alt-text');
    });
});
