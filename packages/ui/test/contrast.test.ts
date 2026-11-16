import { describe, expect, it } from 'vitest';

import {
    checkContrast,
    componentTokenPairs,
    contrastRatio,
    relativeLuminance,
    SEMANTIC_PAIRS,
} from '../src/theme/contrast.ts';
import { TINT_SURFACE_RANGE } from '../src/theme/tint.ts';
import { parseTokenSheet, resolveToken, tokenNames } from '../src/theme/tokens.ts';
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

    it('composites a wash over the page surface', () => {
        const sheet = parseTokenSheet(
            ':root { --color-surface: #ffffff; --ink: #000; --wash: color-mix(in oklab, var(--ink) 50%, transparent); --plain: #808080; }',
        );
        const [light] = checkContrast(sheet, [{ foreground: '--wash', background: '--plain', minimum: 1 }]);
        expect(light?.ratio).toBeCloseTo(contrastRatio('#808080', '#808080'), 1);
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

describe('tinted labels', () => {
    it('are derived against grey levels that still bracket the surfaces they sit on', async () => {
        const sheet = await loadTokenSheet();
        for (const theme of ['light', 'dark'] as const) {
            const channels = (name: string) => {
                const value = resolveToken(sheet, name, theme) ?? '';
                return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
            };
            const text = channels('--color-text');
            const raised = channels('--color-raised');
            const hoverOverRaised = raised.map((channel, index) => channel * 0.95 + (text[index] ?? 0) * 0.05);
            const levels = [
                ...channels('--color-surface'),
                ...raised,
                ...channels('--color-sunken'),
                ...hoverOverRaised,
            ];
            const [low, high] = TINT_SURFACE_RANGE[theme];
            expect(Math.min(...levels), theme).toBeGreaterThanOrEqual(low);
            expect(Math.max(...levels), theme).toBeLessThanOrEqual(high);
        }
    });
});
