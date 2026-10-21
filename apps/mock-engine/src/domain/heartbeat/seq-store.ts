/** Hands out heartbeat `seq` values: strictly increasing across restarts, each persisted before it is returned. */
export interface SeqStore {
    next(): Promise<number>;
}

/**
 * C-03's rule, `max(last + 1, now in ms)`: strictly increasing, and an engine that lost its state but kept its key
 * starts above anything it sent before (as long as its clock does not run backwards), so the dashboard never locks it
 * out as a replay. Gaps are fine.
 */
export function nextSeq(last: number | null, nowMs: number): number {
    return Math.max(last === null ? 0 : last + 1, Math.floor(nowMs));
}
