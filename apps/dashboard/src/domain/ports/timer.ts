/** Waiting, as a port like `Clock`, so tests decide when a deadline passes instead of sleeping. */
export interface Timer {
    /** Resolves after `ms`, or as soon as `signal` aborts; never rejects. */
    wait(ms: number, signal: AbortSignal): Promise<void>;
}
