import { tintStyle as uiTintStyle } from '@ptbk/ui';
import type { CSSProperties } from 'react';

/** How many hues `--color-agent-<n>` offers (packages/ui semantic.css). */
export const AGENT_PALETTE_SIZE = 8;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** FNV-1a: tiny, stable across sessions and browsers, and spreads similar keys (`agent-1`, `agent-2`) apart. */
function hash(text: string): number {
    let value = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        value ^= text.charCodeAt(index);
        value = Math.imul(value, 0x01000193);
    }
    return value >>> 0;
}

/**
 * The colour an agent is shown in: its profile colour when the book sets one, else a hue from the curated palette
 * picked by its key, so an agent keeps its colour across threads and reloads. Returned as a CSS value for `--tint`.
 * The profile colour is engine data; anything but `#rrggbb` is ignored rather than passed into CSS.
 */
export function agentColor(profileColor: string | null | undefined, agentKey: string): string {
    if (profileColor !== null && profileColor !== undefined && HEX_COLOR.test(profileColor)) return profileColor;
    return `var(--color-agent-${String((hash(agentKey) % AGENT_PALETTE_SIZE) + 1)})`;
}

/**
 * Sets `--tint` for the `soft-surface`, `text-tint` and `bg-tint` utilities, with label colours that hold AA for any
 * profile colour (`@ptbk/ui`'s `tintStyle`). React applies it through the CSSOM (`style.setProperty`), which the
 * engine's CSP allows, never as a style attribute string.
 */
export function tintStyle(color: string): CSSProperties {
    return uiTintStyle(color) ?? {};
}
