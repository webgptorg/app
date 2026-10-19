export interface Clock {
    /** Milliseconds since the Unix epoch. */
    nowMs(): number;
}
