import { describe, expect, it } from 'vitest';

import { cpuLoadBucket, percent } from './system-stats';

describe('cpuLoadBucket', () => {
    it('buckets the load per core at 0.5 and 1', () => {
        expect(cpuLoadBucket(0)).toBe('low');
        expect(cpuLoadBucket(0.49)).toBe('low');
        expect(cpuLoadBucket(0.5)).toBe('medium');
        expect(cpuLoadBucket(0.99)).toBe('medium');
        expect(cpuLoadBucket(1)).toBe('high');
        expect(cpuLoadBucket(8)).toBe('high');
    });
});

describe('percent', () => {
    it('computes the share and clamps it into 0–100', () => {
        expect(percent(1, 4)).toBe(25);
        expect(percent(5, 4)).toBe(100);
        expect(percent(-1, 4)).toBe(0);
    });

    it('is 0 for an empty or invalid whole', () => {
        expect(percent(1, 0)).toBe(0);
        expect(percent(1, -5)).toBe(0);
        expect(percent(1, Number.NaN)).toBe(0);
    });
});
