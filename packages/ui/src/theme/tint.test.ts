import { describe, expect, it } from 'vitest';

import { readableTint, safeTint, tintContrast, tintStyle, TINT_TEXT_RESET } from './tint';

const hex = (r: number, g: number, b: number) =>
    `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

/** Twelve hues at five lightnesses each, and the coordinator's three outliers. */
const SWEEP = [
    '#ffff66',
    '#a0e0ff',
    '#222244',
    '#ffffff',
    '#000000',
    ...Array.from({ length: 12 }, (_, hue) =>
        [0.15, 0.35, 0.55, 0.75, 0.95].map((lightness) => {
            const h = (hue * 30) / 360;
            const q = lightness < 0.5 ? lightness * 2 : 1;
            const p = 2 * lightness - q;
            const channel = (t: number) => {
                const x = ((t % 1) + 1) % 1;
                const value =
                    x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
                return Math.round(Math.min(1, Math.max(0, value)) * 255);
            };
            return hex(channel(h + 1 / 3), channel(h), channel(h - 1 / 3));
        }),
    ).flat(),
];

describe('readableTint', () => {
    it.each(SWEEP)('keeps %s readable at AA on its own wash in both themes', (colour) => {
        for (const theme of ['light', 'dark'] as const) {
            const text = readableTint(colour, theme);
            expect(text).toMatch(/^#[0-9a-f]{6}$/);
            expect(tintContrast(text, colour, theme), `${colour} in ${theme} as ${text}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('keeps the hue: a light yellow darkens to a yellow-brown, not to grey', () => {
        const text = readableTint('#ffff66', 'light');
        const [r = 0, g = 0, b = 0] = [1, 3, 5].map((offset) => Number.parseInt(text.slice(offset, offset + 2), 16));
        expect(r).toBeGreaterThan(b);
        expect(g).toBeGreaterThan(b);
    });

    it('leaves a colour that already reads unchanged', () => {
        expect(readableTint('#222244', 'light')).toBe('#222244');
        expect(readableTint('#ffff66', 'dark')).toBe('#ffff66');
    });
});

describe('tintStyle', () => {
    it('derives label colours for a profile colour, once', () => {
        const style = tintStyle('#FFFF66') as Record<string, string>;
        expect(style['--tint']).toBe('#FFFF66');
        expect(style['--tint-text-light']).toBe(readableTint('#ffff66', 'light'));
        expect(style['--tint-text-dark']).toBe(readableTint('#ffff66', 'dark'));
        expect(tintStyle('#ffff66')).toEqual({ ...style, '--tint': '#ffff66' });
    });

    it('resets the label colours for a palette token and refuses anything else', () => {
        expect(tintStyle('var(--color-agent-4)')).toEqual({ '--tint': 'var(--color-agent-4)', ...TINT_TEXT_RESET });
        expect(tintStyle('url(x)')).toBeUndefined();
        expect(safeTint(undefined)).toBeUndefined();
    });
});
