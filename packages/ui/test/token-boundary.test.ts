import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { packageDir } from './theme-sources.ts';
import { findTokenViolations, readSources } from './token-boundary.ts';

const repoRoot = join(packageDir, '..', '..');

describe('token boundary', () => {
    it('holds in packages/ui/src and apps/engine-ui/src', async () => {
        const files = [
            ...(await readSources(repoRoot, 'packages/ui/src')),
            ...(await readSources(repoRoot, 'apps/engine-ui/src')),
        ];
        expect(files.some((file) => file.path === 'packages/ui/src/theme/primitives.css')).toBe(true);
        expect(files.some((file) => file.path.startsWith('apps/engine-ui/src/'))).toBe(true);
        expect(findTokenViolations(files)).toEqual([]);
    });

    it('fails on a component that uses a primitive or a colour literal', async () => {
        const fixture = (name: string) => readFile(join(packageDir, 'test', 'fixtures', name), 'utf8');
        const violations = findTokenViolations([
            { path: 'packages/ui/src/components/bad/bad.tsx', text: await fixture('uses-primitive.tsx') },
            { path: 'apps/engine-ui/src/features/bad/bad.css', text: await fixture('hex-literal.css') },
        ]);
        expect(violations).toEqual([
            'packages/ui/src/components/bad/bad.tsx: primitive --ptbk-cyan-500',
            'apps/engine-ui/src/features/bad/bad.css: colour literal #1a2b3c',
            'apps/engine-ui/src/features/bad/bad.css: colour literal rgb(',
        ]);
    });

    it('allows primitives in the theme and colour literals only in primitives.css', () => {
        expect(
            findTokenViolations([
                { path: 'packages/ui/src/theme/primitives.css', text: ':root { --ptbk-x: #fff; }' },
                { path: 'packages/ui/src/theme/semantic.css', text: ':root { --color-x: var(--ptbk-x); }' },
            ]),
        ).toEqual([]);
        expect(
            findTokenViolations([{ path: 'packages/ui/src/theme/semantic.css', text: ':root { --color-x: #fff; }' }]),
        ).toEqual(['packages/ui/src/theme/semantic.css: colour literal #fff']);
    });

    it('does not mistake identifiers for colours', () => {
        expect(
            findTokenViolations([
                {
                    path: 'apps/engine-ui/src/a.tsx',
                    text: "<a href='#main-content'>{'#add-ons'}</a>; document.querySelector('#root');",
                },
            ]),
        ).toEqual([]);
    });
});
