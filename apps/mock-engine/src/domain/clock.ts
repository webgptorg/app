export interface Clock {
    /** Milliseconds since the Unix epoch. */
    nowMs(): number;
    /** Runs `fn` once after `ms` milliseconds; the returned function cancels it. Never keeps the process alive. */
    setTimeout(fn: () => void, ms: number): () => void;
}
