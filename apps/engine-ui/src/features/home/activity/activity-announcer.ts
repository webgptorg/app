/** At most one announcement per window, so a busy engine does not talk over everything else a screen reader says. */
export const ANNOUNCE_INTERVAL_MS = 10_000;

export interface AnnouncerDeps {
    readonly now: () => number;
    readonly setTimeout: (callback: () => void, ms: number) => unknown;
    readonly clearTimeout: (handle: unknown) => void;
    /** Receives every line that arrived since the last announcement. */
    readonly announce: (lines: readonly string[]) => void;
    readonly intervalMs?: number;
}

export interface Announcer {
    push(lines: readonly string[]): void;
    dispose(): void;
}

/**
 * Batches what arrives: lines pushed in the same tick go out together, and later ones wait until the window since the
 * last announcement has passed, then go out as one batch.
 */
export function createAnnouncer(deps: AnnouncerDeps): Announcer {
    const intervalMs = deps.intervalMs ?? ANNOUNCE_INTERVAL_MS;
    let pending: string[] = [];
    let last = Number.NEGATIVE_INFINITY;
    let timer: unknown;

    const flush = () => {
        timer = undefined;
        if (pending.length === 0) return;
        const lines = pending;
        pending = [];
        last = deps.now();
        deps.announce(lines);
    };

    return {
        push(lines) {
            if (lines.length === 0) return;
            pending.push(...lines);
            if (timer !== undefined) return;
            timer = deps.setTimeout(flush, Math.max(0, last + intervalMs - deps.now()));
        },
        dispose() {
            if (timer !== undefined) deps.clearTimeout(timer);
            timer = undefined;
            pending = [];
        },
    };
}
