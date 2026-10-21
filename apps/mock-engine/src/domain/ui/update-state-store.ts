/**
 * What the loader must remember across restarts so that it can only ever get stricter: when it first saw each release
 * (so a release withheld and shown late still waits the full delay) and the newest revocation list it accepted (so an
 * older list cannot be replayed).
 */
export interface UpdateStateStore {
    /** Stores `now` the first time `payloadSha256` is seen and returns the stored time ever after. */
    firstSeenAt(payloadSha256: string, now: Date): Promise<Date>;
    lastAcceptedRevocationIssuedAt(): Promise<Date | null>;
    /** Records an accepted list's `issuedAt`; an older one than already stored changes nothing. */
    acceptRevocations(issuedAt: Date): Promise<void>;
}

/** Entries kept for `firstSeenAt`; the oldest are dropped beyond it, which can only restart (lengthen) a delay. */
export const MAX_FIRST_SEEN_ENTRIES = 256;
