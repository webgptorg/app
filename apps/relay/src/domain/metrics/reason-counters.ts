/**
 * Why the browser listener closed a connection without relaying it (no byte written). Counted, never logged (spec: no
 * access logs).
 */
export const REFUSAL_REASONS = [
    'no-sni',
    'malformed',
    'too-large',
    'unknown-host',
    'engine-offline',
    'timeout',
    'evicted',
    'global-limit',
    'ip-limit',
    'ipv6-56-limit',
    'ipv6-48-limit',
    'ip-rate',
    'memory-limit',
    'engine-streams',
    'engine-rate',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** Why the relay reset a stream it had already opened. */
export const STREAM_RESET_REASONS = ['drain-timeout', 'first-byte-timeout', 'end-timeout', 'failed'] as const;
export type StreamResetReason = (typeof STREAM_RESET_REASONS)[number];

/** Why the relay cut a tunnel on its own, rather than in answer to the protocol or the registry. */
export const TUNNEL_TERMINATION_REASONS = [
    'frame-budget',
    'ping-buffer',
    'send-buffer',
    'pong-timeout',
    'failed',
] as const;
export type TunnelTerminationReason = (typeof TUNNEL_TERMINATION_REASONS)[number];

/** Counts per reason since start, for I-04. Never who, which hostname or when. */
export interface ReasonCounters<R extends string> {
    count(reason: R): void;
    snapshot(): Readonly<Record<R, number>>;
}

export function createReasonCounters<R extends string>(reasons: readonly R[]): ReasonCounters<R> {
    const counts = Object.fromEntries(reasons.map((reason) => [reason, 0])) as Record<R, number>;
    return {
        count(reason) {
            counts[reason]++;
        },
        snapshot: () => ({ ...counts }),
    };
}
