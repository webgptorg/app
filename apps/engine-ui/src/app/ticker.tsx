import { createContext, use, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

/** The page's visibility, as `document` reports it; injected so tests can hide the tab. */
export interface TickerVisibility {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface TickerDeps {
    readonly now: () => number;
    readonly setInterval: (callback: () => void, ms: number) => unknown;
    readonly clearInterval: (handle: unknown) => void;
    readonly visibility?: TickerVisibility;
    readonly intervalMs?: number;
}

/** A clock that ticks for everyone at once: one interval for the whole app, none while nobody watches or the tab is hidden. */
export interface Ticker {
    readonly subscribe: (listener: () => void) => () => void;
    /** Milliseconds since the epoch, as of the last tick. */
    readonly now: () => number;
}

export function createTicker(deps: TickerDeps): Ticker {
    const intervalMs = deps.intervalMs ?? 1_000;
    const listeners = new Set<() => void>();
    let current = deps.now();
    let handle: unknown;

    const tick = () => {
        current = deps.now();
        for (const listener of [...listeners]) listener();
    };
    const visible = () => deps.visibility?.visibilityState !== 'hidden';
    const sync = () => {
        const shouldRun = listeners.size > 0 && visible();
        if (shouldRun && handle === undefined) {
            // Back from a hidden tab, the time jumped: show it at once rather than a second later.
            tick();
            handle = deps.setInterval(tick, intervalMs);
        } else if (!shouldRun && handle !== undefined) {
            deps.clearInterval(handle);
            handle = undefined;
        }
    };

    return {
        subscribe(listener) {
            listeners.add(listener);
            if (listeners.size === 1) deps.visibility?.addEventListener('visibilitychange', sync);
            sync();
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0) deps.visibility?.removeEventListener('visibilitychange', sync);
                sync();
            };
        },
        now: () => current,
    };
}

/** The browser's clock, ticking once a second while the page is visible. */
export function createBrowserTicker(): Ticker {
    return createTicker({
        now: () => Date.now(),
        setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
        clearInterval: (handle) => {
            globalThis.clearInterval(handle as number);
        },
        ...(typeof document === 'undefined' ? {} : { visibility: document }),
    });
}

const TickerContext = createContext<Ticker | null>(null);

export function TickerProvider({ ticker, children }: { readonly ticker: Ticker; readonly children: ReactNode }) {
    return <TickerContext value={ticker}>{children}</TickerContext>;
}

/** The current time, re-rendering the caller on every tick; for live durations, never for refetching. */
export function useNow(): number {
    const ticker = use(TickerContext);
    if (ticker === null) throw new Error('useNow() needs a <TickerProvider> above it');
    return useSyncExternalStore(ticker.subscribe, ticker.now);
}
