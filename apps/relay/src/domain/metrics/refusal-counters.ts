/** Why the browser listener closed a connection without relaying it. Counted, never logged (spec: no access logs). */
export const REFUSAL_REASONS = [
    'no-sni',
    'malformed',
    'too-large',
    'unknown-host',
    'engine-offline',
    'timeout',
    'global-limit',
    'ip-limit',
    'ip-rate',
    'engine-streams',
    'engine-rate',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** Counts per reason since start, for I-04. Never the SNI, IP or time of a refused connection. */
export interface RefusalCounters {
    count(reason: RefusalReason): void;
    snapshot(): Readonly<Record<RefusalReason, number>>;
}

export function createRefusalCounters(): RefusalCounters {
    const counts = Object.fromEntries(REFUSAL_REASONS.map((reason) => [reason, 0])) as Record<RefusalReason, number>;
    return {
        count(reason) {
            counts[reason]++;
        },
        snapshot: () => ({ ...counts }),
    };
}
