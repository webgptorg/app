import { TUNNEL_CLOSE_CODE } from '@ptbk/protocol';

import type { Random } from '../random';

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_CAP_MS = 10_000;
/** A tunnel that stayed ready this long counts as healthy: losing it starts the backoff from the first step again. */
export const HEALTHY_RESET_MS = 60_000;
/** A draining relay (`SHUTTING_DOWN`) is retried at once, spread over this window so engines do not stampede. */
export const SHUTTING_DOWN_JITTER_MS = 500;

/** Standard WebSocket close code a relay sends after a `rate-limited` reject (C-02); not a `TUNNEL_CLOSE_CODE`. */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013;

// Beyond this the ceiling is the cap anyway; bounding the exponent keeps the arithmetic exact.
const MAX_EXPONENT = 30;

/** Uniform integer in `0..maxInclusive` from 32 random bits; the bias (below 2^-18 for 10 s) is irrelevant for jitter. */
export function randomUpTo(random: Random, maxInclusive: number): number {
    const bytes = random.bytes(4);
    const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    return Math.floor((value / 2 ** 32) * (maxInclusive + 1));
}

/**
 * Full jitter: uniform in `0..min(cap, base · factor^attempt)`, where `attempt` counts consecutive failures from 0.
 * Spreading every retry over the whole interval keeps a fleet of engines from reconnecting in step after an outage.
 */
export function nextDelayMs(attempt: number, random: Random): number {
    if (!Number.isSafeInteger(attempt) || attempt < 0) throw new RangeError('attempt must be a non-negative integer');
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.min(attempt, MAX_EXPONENT));
    return randomUpTo(random, ceiling);
}

export function shuttingDownDelayMs(random: Random): number {
    return randomUpTo(random, SHUTTING_DOWN_JITTER_MS);
}

/** The failure count to back off from after losing a tunnel that was ready for `readyForMs`. */
export function attemptAfterReady(attempt: number, readyForMs: number): number {
    return readyForMs >= HEALTHY_RESET_MS ? 0 : attempt;
}

export type Reconnect =
    | { readonly kind: 'backoff' }
    /** Retry within `SHUTTING_DOWN_JITTER_MS`, without counting a failure. */
    | { readonly kind: 'fast' }
    /** Never reconnect on our own. */
    | { readonly kind: 'stop' };

/**
 * What a close of a ready tunnel means for the next attempt. `REPLACED` stops: another holder of this engine's key
 * took the slot, and reconnecting would replace it in turn, the loop C-02 forbids. `AUTH_FAILED`, `SUSPENDED`,
 * `PROTOCOL_ERROR`, 1013 and a lost connection back off normally.
 */
export function reconnectAfterClose(code: number): Reconnect {
    switch (code) {
        case TUNNEL_CLOSE_CODE.SHUTTING_DOWN:
            return { kind: 'fast' };
        case TUNNEL_CLOSE_CODE.REPLACED:
            return { kind: 'stop' };
        default:
            return { kind: 'backoff' };
    }
}
