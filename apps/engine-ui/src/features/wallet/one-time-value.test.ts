import { describe, expect, it } from 'vitest';

import { OneTimeValue } from './one-time-value';

describe('OneTimeValue', () => {
    it('hands its value over once and serialises to nothing', () => {
        const value = new OneTimeValue('secret');
        expect(JSON.stringify({ value })).toBe('{"value":{}}');
        expect(value.take()).toBe('secret');
        expect(value.take()).toBe('');
    });
});
