import { TUNNEL_CLOSE_CODE } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createFixedRandom, createSeededRandom } from '../../testing/seeded-random';
import {
    BACKOFF_BASE_MS,
    BACKOFF_CAP_MS,
    HEALTHY_RESET_MS,
    SHUTTING_DOWN_JITTER_MS,
    WS_CLOSE_TRY_AGAIN_LATER,
    attemptAfterReady,
    nextDelayMs,
    randomUpTo,
    reconnectAfterClose,
    shuttingDownDelayMs,
} from './backoff';

const MAX = [0xff, 0xff, 0xff, 0xff];

describe('nextDelayMs', () => {
    it('stays within 0..base·2^attempt for every attempt below the cap', () => {
        const random = createSeededRandom(1);
        for (let attempt = 0; attempt < 5; attempt++) {
            const ceiling = BACKOFF_BASE_MS * 2 ** attempt;
            for (let sample = 0; sample < 200; sample++) {
                const delay = nextDelayMs(attempt, random);
                expect(delay).toBeGreaterThanOrEqual(0);
                expect(delay).toBeLessThanOrEqual(ceiling);
                expect(Number.isInteger(delay)).toBe(true);
            }
        }
    });

    it('never exceeds the 10 s cap, however many attempts failed', () => {
        const random = createSeededRandom(2);
        for (const attempt of [5, 6, 20, 1000, Number.MAX_SAFE_INTEGER]) {
            for (let sample = 0; sample < 200; sample++) {
                expect(nextDelayMs(attempt, random)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
            }
        }
    });

    it('uses full jitter: the extremes of the random range map to 0 and the ceiling', () => {
        expect(nextDelayMs(0, createFixedRandom([0, 0, 0, 0]))).toBe(0);
        expect(nextDelayMs(0, createFixedRandom(MAX))).toBe(BACKOFF_BASE_MS);
        expect(nextDelayMs(1, createFixedRandom(MAX))).toBe(BACKOFF_BASE_MS * 2);
        expect(nextDelayMs(4, createFixedRandom(MAX))).toBe(8_000);
        expect(nextDelayMs(5, createFixedRandom(MAX))).toBe(BACKOFF_CAP_MS);
    });

    it('spreads delays over the interval instead of clustering', () => {
        const random = createSeededRandom(3);
        const delays = Array.from({ length: 1000 }, () => nextDelayMs(10, random));
        expect(Math.min(...delays)).toBeLessThan(BACKOFF_CAP_MS * 0.1);
        expect(Math.max(...delays)).toBeGreaterThan(BACKOFF_CAP_MS * 0.9);
    });

    it('refuses a negative or fractional attempt', () => {
        const random = createSeededRandom(4);
        expect(() => nextDelayMs(-1, random)).toThrow(RangeError);
        expect(() => nextDelayMs(1.5, random)).toThrow(RangeError);
    });
});

describe('randomUpTo', () => {
    it('reads a big-endian u32 from a subarray', () => {
        const random = { bytes: () => Uint8Array.of(9, 0x80, 0, 0, 0).subarray(1) };
        expect(randomUpTo(random, 99)).toBe(50);
    });
});

describe('reset after a healthy period', () => {
    it('restarts the backoff only when the tunnel was ready for at least 60 s', () => {
        expect(attemptAfterReady(7, HEALTHY_RESET_MS)).toBe(0);
        expect(attemptAfterReady(7, HEALTHY_RESET_MS + 1)).toBe(0);
        expect(attemptAfterReady(7, HEALTHY_RESET_MS - 1)).toBe(7);
    });
});

describe('reconnectAfterClose', () => {
    it('retries a draining relay fast, within 0–500 ms', () => {
        expect(reconnectAfterClose(TUNNEL_CLOSE_CODE.SHUTTING_DOWN)).toEqual({ kind: 'fast' });
        const random = createSeededRandom(5);
        for (let sample = 0; sample < 200; sample++) {
            const delay = shuttingDownDelayMs(random);
            expect(delay).toBeGreaterThanOrEqual(0);
            expect(delay).toBeLessThanOrEqual(SHUTTING_DOWN_JITTER_MS);
        }
        expect(shuttingDownDelayMs(createFixedRandom(MAX))).toBe(SHUTTING_DOWN_JITTER_MS);
    });

    it('backs off normally on 1013, AUTH_FAILED, SUSPENDED, PROTOCOL_ERROR and a lost connection', () => {
        for (const code of [
            WS_CLOSE_TRY_AGAIN_LATER,
            TUNNEL_CLOSE_CODE.AUTH_FAILED,
            TUNNEL_CLOSE_CODE.SUSPENDED,
            TUNNEL_CLOSE_CODE.PROTOCOL_ERROR,
            1006,
            1000,
        ]) {
            expect(reconnectAfterClose(code)).toEqual({ kind: 'backoff' });
        }
    });

    it('never reconnects in a loop after REPLACED', () => {
        expect(reconnectAfterClose(TUNNEL_CLOSE_CODE.REPLACED)).toEqual({ kind: 'stop' });
    });
});
