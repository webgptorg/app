import type { CSSProperties } from 'react';

const SAFE_TINT = /^(?:#[0-9a-f]{6}|var\(--color-[a-z0-9-]+\))$/i;

/** A tint value safe to hand to the CSSOM: a validated hex or one of our own colour tokens, never `url()` or the like. */
export function safeTint(tint: string | null | undefined): string | undefined {
    return tint !== null && tint !== undefined && SAFE_TINT.test(tint) ? tint : undefined;
}

/** `--tint` as a style object; React applies it through the CSSOM (`style.setProperty`), which the CSP allows. */
export function tintStyle(tint: string | null | undefined): CSSProperties | undefined {
    const safe = safeTint(tint);
    return safe === undefined ? undefined : ({ '--tint': safe } as CSSProperties);
}
