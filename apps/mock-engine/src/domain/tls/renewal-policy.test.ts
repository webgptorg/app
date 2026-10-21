import { describe, expect, it } from 'vitest';

import {
    RENEWAL_CHECK_INTERVAL_MS,
    nextRenewalCheckMs,
    renewalDue,
    renewalDueAtMs,
    renewalRetryDelayMs,
} from './renewal-policy';

const DAY_MS = 86_400_000;
const NINETY_DAYS = { notBeforeMs: 1_000 * DAY_MS, notAfterMs: 1_090 * DAY_MS };

function at(fraction: number): number {
    return NINETY_DAYS.notBeforeMs + fraction * (NINETY_DAYS.notAfterMs - NINETY_DAYS.notBeforeMs);
}

describe('renewal policy', () => {
    it('is not due at 10 % or 50 % of the lifetime, and due at 90 %', () => {
        expect(renewalDue(NINETY_DAYS, at(0.1))).toBe(false);
        expect(renewalDue(NINETY_DAYS, at(0.5))).toBe(false);
        expect(renewalDue(NINETY_DAYS, at(0.9))).toBe(true);
    });

    it('falls due once a third of the lifetime remains: day 60 of 90', () => {
        expect(renewalDueAtMs(NINETY_DAYS)).toBe(1_060 * DAY_MS);
        expect(renewalDue(NINETY_DAYS, 1_060 * DAY_MS - 1)).toBe(false);
        expect(renewalDue(NINETY_DAYS, 1_060 * DAY_MS)).toBe(true);
        expect(renewalDue(NINETY_DAYS, NINETY_DAYS.notAfterMs + 1)).toBe(true);
    });

    it('scales to short lifetimes, such as a 90-second test certificate', () => {
        const short = { notBeforeMs: 0, notAfterMs: 90_000 };
        expect(renewalDueAtMs(short)).toBe(60_000);
        expect(nextRenewalCheckMs(short, 10_000)).toBe(50_000);
    });

    it('renews a certificate with no lifetime at all (or an inverted one) by its notAfter at the latest', () => {
        expect(renewalDueAtMs({ notBeforeMs: 5_000, notAfterMs: 5_000 })).toBe(5_000);
        expect(renewalDueAtMs({ notBeforeMs: 9_000, notAfterMs: 5_000 })).toBe(5_000);
    });

    it('looks again every 12 h, or when renewal falls due if that is sooner, never in the past', () => {
        expect(nextRenewalCheckMs(NINETY_DAYS, at(0.1))).toBe(RENEWAL_CHECK_INTERVAL_MS);
        expect(nextRenewalCheckMs(NINETY_DAYS, 1_060 * DAY_MS - 1_000)).toBe(1_000);
        expect(nextRenewalCheckMs(NINETY_DAYS, at(0.9))).toBe(0);
    });

    it('retries after 5 s, doubling up to an hour', () => {
        expect([1, 2, 3, 4].map(renewalRetryDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
        expect(renewalRetryDelayMs(10)).toBe(2_560_000);
        expect(renewalRetryDelayMs(11)).toBe(3_600_000);
        expect(renewalRetryDelayMs(1_000)).toBe(3_600_000);
        expect(renewalRetryDelayMs(0)).toBe(5_000);
    });
});
