import type { CSSProperties } from 'react';

const HEX = /^#[0-9a-f]{6}$/i;
const SAFE_TINT = /^(?:#[0-9a-f]{6}|var\(--color-[a-z0-9-]+\))$/i;

/** A tint value safe to hand to the CSSOM: a validated hex or one of our own colour tokens, never `url()` or the like. */
export function safeTint(tint: string | null | undefined): string | undefined {
    return tint !== null && tint !== undefined && SAFE_TINT.test(tint) ? tint : undefined;
}

type Rgb = readonly [number, number, number];
type Theme = 'light' | 'dark';

/**
 * The grey levels (0–255) a tinted label can sit on, per theme: from the sunken surface to a raised one under a hover
 * wash. Channel values, not colours: primitives.css owns the palette, and a test checks these still bracket it.
 */
export const TINT_SURFACE_RANGE: Readonly<Record<Theme, readonly [number, number]>> = {
    light: [241, 255],
    dark: [12, 40],
};

/** The strongest wash of the tint behind its own label: a chip's hover wash over an agent's soft surface. */
export const TINT_MAX_WASH = 0.24;

/** A hair above AA's 4.5:1, so rounding to 8-bit channels never lands below it. */
const TARGET_CONTRAST = 4.6;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const toLinear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const fromLinear = (channel: number) => (channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055);
const triple = (r: number, g: number, b: number): Rgb => [r, g, b];

function parseHex(hex: string): Rgb {
    const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return triple(channel(1), channel(3), channel(5));
}

function toHex([r, g, b]: Rgb): string {
    const byte = (channel: number) =>
        Math.round(clamp(channel) * 255)
            .toString(16)
            .padStart(2, '0');
    return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** WCAG relative luminance; `tintContrast` and the tests use the same maths as `theme/contrast.ts`. */
export function tintLuminance([r, g, b]: Rgb): number {
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrast(a: number, b: number): number {
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** sRGB (0–1) to OKLab (Björn Ottosson's matrices). */
function toOklab([r, g, b]: Rgb): Rgb {
    const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return triple(
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    );
}

/** OKLab to sRGB (0–1), clipped to the gamut, which is what the screen shows. */
function fromOklab([lightness, a, b]: Rgb): Rgb {
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const channel = (value: number) => clamp(fromLinear(clamp(value)));
    return triple(
        channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    );
}

/** Every background the label can meet in a theme: each surface bound, bare and under the strongest wash. */
export function tintBackgrounds(hex: string, theme: Theme): number[] {
    const [r, g, b] = parseHex(hex);
    return TINT_SURFACE_RANGE[theme].flatMap((grey) =>
        [0, TINT_MAX_WASH].map((wash) => {
            const mix = (channel: number) => channel * wash + (grey / 255) * (1 - wash);
            return tintLuminance(triple(mix(r), mix(g), mix(b)));
        }),
    );
}

/** The lowest contrast of `text` against every background `tint`'s label can meet in `theme`. */
export function tintContrast(text: string, tint: string, theme: Theme): number {
    const own = tintLuminance(parseHex(text));
    return Math.min(...tintBackgrounds(tint, theme).map((background) => contrast(own, background)));
}

/**
 * The tint as a label colour that reads at AA on its own wash in `theme`: the same hue and chroma, with OKLCH lightness
 * moved (darker in light, lighter in dark) until it holds against every background the label can meet.
 */
export function readableTint(hex: string, theme: Theme): string {
    const [start, a, b] = toOklab(parseHex(hex));
    const step = theme === 'light' ? -0.01 : 0.01;
    for (let lightness = start; lightness >= 0 && lightness <= 1; lightness += step) {
        const candidate = toHex(fromOklab(triple(lightness, a, b)));
        if (tintContrast(candidate, hex, theme) >= TARGET_CONTRAST) return candidate;
    }
    return toHex(theme === 'light' ? triple(0, 0, 0) : triple(1, 1, 1));
}

const readable = new Map<string, { readonly light: string; readonly dark: string }>();

function readableTints(hex: string): { readonly light: string; readonly dark: string } {
    const key = hex.toLowerCase();
    const known = readable.get(key);
    if (known !== undefined) return known;
    const found = { light: readableTint(key, 'light'), dark: readableTint(key, 'dark') };
    readable.set(key, found);
    return found;
}

/**
 * Clears inherited label colours, so `text-tint` falls back to its own mix of `--tint`: for our palette tokens, which
 * already hold AA, and for an element that sets its tint through a class inside another agent's tinted container.
 */
export const TINT_TEXT_RESET: CSSProperties = {
    '--tint-text-light': 'initial',
    '--tint-text-dark': 'initial',
} as CSSProperties;

/**
 * `--tint`, and the label colours `text-tint` uses, as a style object; React applies it through the CSSOM
 * (`style.setProperty`), which the CSP allows. A profile colour (`#rrggbb`) can be anything, so its label colours are
 * derived per theme to hold AA on its own wash.
 */
export function tintStyle(tint: string | null | undefined): CSSProperties | undefined {
    const safe = safeTint(tint);
    if (safe === undefined) return undefined;
    if (!HEX.test(safe)) return { '--tint': safe, ...TINT_TEXT_RESET } as CSSProperties;
    const { light, dark } = readableTints(safe);
    return { '--tint': safe, '--tint-text-light': light, '--tint-text-dark': dark } as CSSProperties;
}
