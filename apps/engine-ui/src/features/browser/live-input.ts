import { LIVE_NAMED_KEYS, LiveKey, MAX_LIVE_COORDINATE, MAX_LIVE_INPUT_PER_S, MAX_WHEEL_DELTA } from '@ptbk/engine-api';

/** Where the picture of the tab sits on screen, in CSS px (`getBoundingClientRect()`). */
export interface ViewerBox {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export interface TabViewport {
    readonly width: number;
    readonly height: number;
}

export interface TabPoint {
    readonly x: number;
    readonly y: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 100) / 100;

/**
 * A point on the picture in the tab's own CSS px: the picture is scaled to fit the page, the tab keeps its viewport.
 * Clamped to the viewport, since a captured pointer may leave the picture mid-drag.
 */
export function toTabPoint(clientX: number, clientY: number, box: ViewerBox, viewport: TabViewport): TabPoint | null {
    if (box.width <= 0 || box.height <= 0) return null;
    const maxX = Math.min(viewport.width, MAX_LIVE_COORDINATE);
    const maxY = Math.min(viewport.height, MAX_LIVE_COORDINATE);
    return {
        x: round(clamp(((clientX - box.left) / box.width) * viewport.width, 0, maxX)),
        y: round(clamp(((clientY - box.top) / box.height) * viewport.height, 0, maxY)),
    };
}

export type LiveButton = 'none' | 'left' | 'middle' | 'right';

/** `PointerEvent.button` of a press or release; `null` for the back, forward and pen-eraser buttons. */
export function pressedButton(button: number): LiveButton | null {
    switch (button) {
        case 0:
            return 'left';
        case 1:
            return 'middle';
        case 2:
            return 'right';
        default:
            return null;
    }
}

/** The button held during a move, from `PointerEvent.buttons`, so a drag reaches the page as one. */
export function heldButton(buttons: number): LiveButton {
    if ((buttons & 1) !== 0) return 'left';
    if ((buttons & 2) !== 0) return 'right';
    if ((buttons & 4) !== 0) return 'middle';
    return 'none';
}

const LINE_PX = 16;
const PAGE_PX = 800;

/** A wheel delta in CSS px within the contract's bound, whatever unit the browser reported it in. */
export function wheelDelta(delta: number, deltaMode: number): number {
    const px = deltaMode === 1 ? delta * LINE_PX : deltaMode === 2 ? delta * PAGE_PX : delta;
    return round(clamp(px, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA));
}

export interface KeyLike {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly altKey: boolean;
    readonly isComposing?: boolean;
}

const NAMED_KEYS: ReadonlySet<string> = new Set(LIVE_NAMED_KEYS);

/**
 * The key as the contract takes it, or `null` for one that stays with this page: anything with Ctrl, Cmd or Alt (so
 * no shortcut reaches the clipboard, print, save or devtools of the engine's browser), function keys, modifiers alone
 * and IME composition. Shift is the only modifier sent.
 */
export function liveKey(event: KeyLike): { readonly key: string; readonly shift: boolean } | null {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing === true) return null;
    if (NAMED_KEYS.has(event.key) || LiveKey.safeParse(event.key).success) {
        return { key: event.key, shift: event.shiftKey };
    }
    return null;
}

/** Below the engine's limit, so a burst never ends the channel; moves and wheel give way first. */
const ESSENTIAL_PER_S = MAX_LIVE_INPUT_PER_S - 8;
const OPTIONAL_PER_S = Math.floor(MAX_LIVE_INPUT_PER_S * 0.75);

/**
 * A sliding one-second window over sent input: more than `MAX_LIVE_INPUT_PER_S` in any second ends the channel, so
 * the browser drops pointer moves and wheel steps first and presses and keys only near the limit.
 */
export function createInputBudget(now: () => number): (essential: boolean) => boolean {
    const sent: number[] = [];
    return (essential) => {
        const at = now();
        while (sent.length > 0 && at - (sent[0] ?? at) >= 1_000) sent.shift();
        if (sent.length >= (essential ? ESSENTIAL_PER_S : OPTIONAL_PER_S)) return false;
        sent.push(at);
        return true;
    };
}

const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 5;

/** The press count of a click (2 for the second press of a double click): pointer events carry none of their own. */
export function createClickCounter(now: () => number): (x: number, y: number) => number {
    let last: { readonly at: number; readonly x: number; readonly y: number; readonly count: number } | null = null;
    return (x, y) => {
        const at = now();
        const near =
            last !== null &&
            at - last.at < MULTI_CLICK_MS &&
            Math.abs(x - last.x) < MULTI_CLICK_PX &&
            Math.abs(y - last.y) < MULTI_CLICK_PX;
        const count = near && last !== null ? Math.min(3, last.count + 1) : 1;
        last = { at, x, y, count };
        return count;
    };
}
