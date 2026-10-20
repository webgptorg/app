import { describe, expect, it } from 'vitest';

import {
    checkContrast,
    componentTokenPairs,
    contrastRatio,
    relativeLuminance,
    SEMANTIC_PAIRS,
} from '../src/theme/contrast.ts';
import { parseTokenSheet, tokenNames } from '../src/theme/tokens.ts';
import { loadTokenSheet } from './theme-sources.ts';

describe('contrastRatio', () => {
    it('matches the WCAG reference values', () => {
        expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
        expect(contrastRatio('#fff', '#fff')).toBe(1);
        expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
        expect(contrastRatio('#ffffff', '#777')).toBeCloseTo(4.48, 2);
        expect(relativeLuminance('#808080')).toBeCloseTo(0.2159, 4);
    });

    it('refuses anything but hex colours', () => {
        expect(() => relativeLuminance('red')).toThrow(/hex/);
    });

    it('fails a pair that does not resolve to colours', () => {
        const sheet = parseTokenSheet(':root { --a: #000; --b: var(--missing); }');
        const results = checkContrast(sheet, [{ foreground: '--a', background: '--b', minimum: 4.5 }]);
        expect(results.map((result) => result.ratio)).toEqual([0, 0]);
    });

    it('derives text-on-background pairs from component token names', () => {
        expect(
            componentTokenPairs([
                '--chip-bg',
                '--chip-text',
                '--tag-bg',
                '--tag-fg',
                '--lone-bg',
                '--color-x-bg',
                '--color-x-text',
            ]),
        ).toEqual([
            { foreground: '--chip-text', background: '--chip-bg', minimum: 4.5 },
            { foreground: '--tag-fg', background: '--tag-bg', minimum: 4.5 },
        ]);
    });
});

describe('theme contrast', () => {
    it('holds for every semantic and component token pair in light and dark', async () => {
        const sheet = await loadTokenSheet();
        const pairs = [...SEMANTIC_PAIRS, ...componentTokenPairs(tokenNames(sheet))];
        const results = checkContrast(sheet, pairs);
        expect(results.length).toBeGreaterThanOrEqual(SEMANTIC_PAIRS.length * 2);
        const failing = results
            .filter((result) => result.ratio < result.minimum)
            .map(
                (result) =>
                    `${result.theme}: ${result.foreground} on ${result.background} = ${result.ratio.toFixed(2)} < ${String(result.minimum)}`,
            );
        expect(failing).toEqual([]);
    });
});
