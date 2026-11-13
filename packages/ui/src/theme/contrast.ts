import { resolveToken } from './tokens';
import type { TokenSheet } from './tokens';

/** WCAG 2.2 AA: body text 4.5:1; large text, borders, focus rings and other graphics 3:1. */
export const TEXT_CONTRAST = 4.5;
export const GRAPHIC_CONTRAST = 3;

export interface TokenPair {
    readonly foreground: string;
    readonly background: string;
    readonly minimum: number;
}

const text = (foreground: string, ...backgrounds: string[]): TokenPair[] =>
    backgrounds.map((background) => ({ foreground, background, minimum: TEXT_CONTRAST }));
const graphic = (foreground: string, ...backgrounds: string[]): TokenPair[] =>
    backgrounds.map((background) => ({ foreground, background, minimum: GRAPHIC_CONTRAST }));

const SURFACES = ['--color-surface', '--color-raised'];

/** The semantic pairs the components rely on. Component tokens add their own pairs (see `componentTokenPairs`). */
export const SEMANTIC_PAIRS: readonly TokenPair[] = [
    ...text(
        '--color-text',
        ...SURFACES,
        '--color-sunken',
        '--color-hover',
        '--color-selected',
        '--color-neutral-soft',
        '--color-accent-soft',
        '--color-selection',
    ),
    ...text('--color-text-muted', ...SURFACES, '--color-sunken', '--color-hover', '--color-neutral-soft'),
    ...text('--color-text-subtle', ...SURFACES),
    ...text('--color-accent-text', ...SURFACES, '--color-selected', '--color-accent-soft'),
    ...text('--color-on-primary', '--color-primary', '--color-primary-hover'),
    ...text('--color-on-accent', '--color-accent', '--color-accent-hover'),
    ...text('--color-on-danger', '--color-danger', '--color-danger-hover'),
    ...text('--color-on-danger-fill', '--color-danger-fill', '--color-danger-fill-hover'),
    ...text('--color-link', ...SURFACES, '--color-sunken'),
    ...text('--color-link-hover', ...SURFACES),
    ...text('--color-success', '--color-success-soft', ...SURFACES),
    ...text('--color-warning', '--color-warning-soft', ...SURFACES),
    ...text('--color-danger', '--color-danger-soft', ...SURFACES),
    ...text('--color-info', '--color-info-soft', ...SURFACES),
    ...graphic('--color-border', ...SURFACES, '--color-sunken'),
    ...graphic('--color-focus', ...SURFACES, '--color-sunken'),
    ...graphic('--color-primary', ...SURFACES),
    ...graphic('--color-accent', ...SURFACES),
    ...graphic('--color-live', ...SURFACES),
    ...[1, 2, 3, 4, 5, 6].flatMap((index) => graphic(`--color-identity-${String(index)}`, ...SURFACES)),
    ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((index) =>
        text(`--color-agent-${String(index)}`, ...SURFACES, '--color-sunken'),
    ),
];

/**
 * A component token named `<prefix>-text` (or `-fg`) is text on `<prefix>-bg`, e.g. `--button-primary-text` on
 * `--button-primary-bg`, so a component that adds a coloured variant is checked without listing it here.
 */
export function componentTokenPairs(names: readonly string[]): TokenPair[] {
    const pairs: TokenPair[] = [];
    for (const name of names) {
        if (name.startsWith('--color-') || name.startsWith('--ptbk-')) continue;
        const prefix = /^(.*)-bg$/.exec(name)?.[1];
        if (prefix === undefined) continue;
        for (const foreground of [`${prefix}-text`, `${prefix}-fg`]) {
            if (names.includes(foreground)) pairs.push({ foreground, background: name, minimum: TEXT_CONTRAST });
        }
    }
    return pairs;
}

/** Linear-light relative luminance of an sRGB `#rgb` or `#rrggbb` colour (WCAG 2.2). */
export function relativeLuminance(hex: string): number {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
    if (match?.[1] === undefined) throw new Error(`not a hex colour: ${hex}`);
    const digits = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1];
    const [r = 0, g = 0, b = 0] = [0, 2, 4].map((offset) => {
        const channel = Number.parseInt(digits.slice(offset, offset + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two hex colours, from 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
    const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
    return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

export interface ContrastResult extends TokenPair {
    readonly theme: 'light' | 'dark';
    readonly ratio: number;
}

const WASH = /^color-mix\(in (?:oklab|srgb), (#[0-9a-f]{3,6}) (\d+(?:\.\d+)?)%, transparent\)$/i;

function channels(hex: string): number[] {
    const digits = hex.slice(1).length === 3 ? hex.slice(1).replace(/./g, '$&$&') : hex.slice(1);
    return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16));
}

/**
 * A wash (`color-mix(in oklab, <colour> N%, transparent)`, e.g. `--color-hover`) as the hex it shows over the page
 * surface. Alpha-blended in sRGB: for the few percent a wash uses, the difference to oklab is far below what the
 * ratio check can see.
 */
function composite(value: string, surface: string | undefined): string | undefined {
    const match = WASH.exec(value);
    if (match === null || surface?.startsWith('#') !== true) return value;
    const [, colour = '', percent = '0'] = match;
    const alpha = Number(percent) / 100;
    const top = channels(colour);
    const blended = channels(surface).map((base, index) => Math.round((top[index] ?? 0) * alpha + base * (1 - alpha)));
    return `#${blended.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** Every pair resolved in both themes. A pair whose tokens do not resolve to hex colours fails with ratio 0. */
export function checkContrast(sheet: TokenSheet, pairs: readonly TokenPair[]): ContrastResult[] {
    return (['light', 'dark'] as const).flatMap((theme) =>
        pairs.map((pair) => {
            const surface = resolveToken(sheet, '--color-surface', theme);
            const resolve = (name: string) => {
                const value = resolveToken(sheet, name, theme);
                return value === undefined ? undefined : composite(value, surface);
            };
            const foreground = resolve(pair.foreground);
            const background = resolve(pair.background);
            const ratio =
                foreground?.startsWith('#') === true && background?.startsWith('#') === true
                    ? contrastRatio(foreground, background)
                    : 0;
            return { ...pair, theme, ratio };
        }),
    );
}
