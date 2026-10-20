/**
 * Reads the token layers from their CSS source, so tests can check them without a browser: contrast for every pair,
 * the reduced-motion values, and what a different primitives file changes. Understands exactly what the theme files
 * use: custom properties on `:root`, on `.dark`, and on `:root` inside `@media (prefers-reduced-motion: reduce)`.
 */
export interface TokenSheet {
    readonly light: ReadonlyMap<string, string>;
    readonly dark: ReadonlyMap<string, string>;
    readonly reducedMotion: ReadonlyMap<string, string>;
}

export type TokenContext = 'light' | 'dark' | 'reduced-motion';

const DECLARATION = /(--[\w-]+)\s*:\s*([^;]+);/g;

function declarations(body: string): Map<string, string> {
    const found = new Map<string, string>();
    for (const [, name = '', value = ''] of body.matchAll(DECLARATION))
        found.set(name, value.trim().replace(/\s+/g, ' '));
    return found;
}

/** Top-level `prelude { body }` blocks, with nested braces kept inside the body. */
function blocks(css: string): { prelude: string; body: string }[] {
    const found: { prelude: string; body: string }[] = [];
    let depth = 0;
    let start = 0;
    let preludeStart = 0;
    for (let index = 0; index < css.length; index += 1) {
        const char = css[index];
        if (char === '{') {
            if (depth === 0) start = index;
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                found.push({ prelude: css.slice(preludeStart, start).trim(), body: css.slice(start + 1, index) });
                preludeStart = index + 1;
            }
        } else if (char === ';' && depth === 0) {
            preludeStart = index + 1;
        }
    }
    return found;
}

function selectors(prelude: string): string[] {
    return prelude.split(',').map((selector) => selector.trim());
}

/** Parses one or more CSS sources (later sources override earlier ones, as in the cascade). */
export function parseTokenSheet(...sources: readonly string[]): TokenSheet {
    const light = new Map<string, string>();
    const dark = new Map<string, string>();
    const reducedMotion = new Map<string, string>();
    for (const source of sources) {
        const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
        for (const { prelude, body } of blocks(css)) {
            if (prelude.startsWith('@media') && prelude.includes('prefers-reduced-motion: reduce')) {
                for (const inner of blocks(body)) {
                    if (selectors(inner.prelude).includes(':root')) {
                        for (const [name, value] of declarations(inner.body)) reducedMotion.set(name, value);
                    }
                }
                continue;
            }
            const targets = selectors(prelude);
            if (targets.includes(':root')) for (const [name, value] of declarations(body)) light.set(name, value);
            if (targets.includes('.dark')) for (const [name, value] of declarations(body)) dark.set(name, value);
        }
    }
    return { light, dark, reducedMotion };
}

const VAR = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/;

/** The token's value with every `var()` replaced, in a theme; `undefined` when it or a reference is not defined. */
export function resolveToken(sheet: TokenSheet, name: string, context: TokenContext): string | undefined {
    const lookup = (token: string): string | undefined => {
        if (context === 'reduced-motion' && sheet.reducedMotion.has(token)) return sheet.reducedMotion.get(token);
        if (context === 'dark' && sheet.dark.has(token)) return sheet.dark.get(token);
        return sheet.light.get(token);
    };
    const seen = new Set<string>();
    let value = lookup(name);
    for (let match = value?.match(VAR); value !== undefined && match; match = value.match(VAR)) {
        const [whole, reference = '', fallback] = match;
        if (seen.has(reference)) return undefined;
        seen.add(reference);
        const replacement = lookup(reference) ?? fallback?.trim();
        if (replacement === undefined) return undefined;
        value = value.replace(whole, replacement);
    }
    return value;
}

/** Every token name defined in any context. */
export function tokenNames(sheet: TokenSheet): string[] {
    return [...new Set([...sheet.light.keys(), ...sheet.dark.keys(), ...sheet.reducedMotion.keys()])].sort();
}
