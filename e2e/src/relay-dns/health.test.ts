import { describe, expect, it } from 'vitest';

import { createRelayHealth } from './health.ts';

const A = 'relay-a';
const B = 'relay-b';
const C = 'relay-c';
const THRESHOLDS = { consecutiveDown: 2, consecutiveUp: 3 };

function failTimes(health: ReturnType<typeof createRelayHealth<string>>, relay: string, times: number): void {
    for (let i = 0; i < times; i++) health.record(relay, false);
}

describe('relay health', () => {
    it('lists every relay before the first check', () => {
        expect(createRelayHealth([A, B], THRESHOLDS).listed()).toEqual([A, B]);
    });

    it('drops a relay only after consecutiveDown failures in a row', () => {
        const health = createRelayHealth([A, B], THRESHOLDS);
        expect(health.record(A, false)).toBeNull();
        expect(health.listed()).toEqual([A, B]);
        expect(health.record(A, false)).toEqual({ relay: A, healthy: false, listed: [B], fallback: false });
        expect(health.listed()).toEqual([B]);
    });

    it('starts counting failures again after a pass', () => {
        const health = createRelayHealth([A, B], THRESHOLDS);
        health.record(A, false);
        health.record(A, true);
        expect(health.record(A, false)).toBeNull();
        expect(health.listed()).toEqual([A, B]);
    });

    it('brings a relay back only after consecutiveUp passes in a row, in its configured place', () => {
        const health = createRelayHealth([A, B], THRESHOLDS);
        failTimes(health, A, 2);
        expect(health.record(A, true)).toBeNull();
        expect(health.record(A, false)).toBeNull();
        expect(health.record(A, true)).toBeNull();
        expect(health.record(A, true)).toBeNull();
        expect(health.listed()).toEqual([B]);
        expect(health.record(A, true)).toEqual({ relay: A, healthy: true, listed: [A, B], fallback: false });
    });

    it('never removes the last healthy relay: with none healthy, every relay is listed', () => {
        const health = createRelayHealth([A, B, C], THRESHOLDS);
        failTimes(health, A, 2);
        failTimes(health, B, 2);
        expect(health.listed()).toEqual([C]);
        health.record(C, false);
        expect(health.record(C, false)).toEqual({ relay: C, healthy: false, listed: [A, B, C], fallback: true });
        expect(health.listed()).toEqual([A, B, C]);
        expect(health.isFallback()).toBe(true);
    });

    it('leaves the fallback with the first relay that recovers', () => {
        const health = createRelayHealth([A, B], THRESHOLDS);
        failTimes(health, A, 2);
        failTimes(health, B, 2);
        for (let i = 0; i < 2; i++) health.record(B, true);
        expect(health.record(B, true)).toEqual({ relay: B, healthy: true, listed: [B], fallback: false });
        expect(health.isFallback()).toBe(false);
    });

    it('reports exactly one change per transition and none while the state holds', () => {
        const health = createRelayHealth([A, B], { consecutiveDown: 1, consecutiveUp: 1 });
        const outcomes = [true, false, false, true, true, false];
        const changes = outcomes.map((passed) => health.record(A, passed)).filter((change) => change !== null);
        expect(changes.map((change) => change.healthy)).toEqual([false, true, false]);
    });

    it('refuses thresholds below one and an empty relay list', () => {
        expect(() => createRelayHealth([A], { consecutiveDown: 0, consecutiveUp: 1 })).toThrow(/positive/);
        expect(() => createRelayHealth([A], { consecutiveDown: 1, consecutiveUp: 1.5 })).toThrow(/positive/);
        expect(() => createRelayHealth([], THRESHOLDS)).toThrow(/at least one/);
    });

    it('refuses a relay it was not given', () => {
        expect(() => createRelayHealth([A], THRESHOLDS).record(B, true)).toThrow(/unknown/);
    });
});
