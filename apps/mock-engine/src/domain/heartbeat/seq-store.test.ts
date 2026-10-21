import { describe, expect, it } from 'vitest';

import { nextSeq } from './seq-store';

describe('nextSeq', () => {
    it('starts at the current time in ms', () => {
        expect(nextSeq(null, 1_760_000_000_000)).toBe(1_760_000_000_000);
    });

    it('takes last + 1 when the clock has not moved past it', () => {
        expect(nextSeq(1_760_000_000_000, 1_760_000_000_000)).toBe(1_760_000_000_001);
        expect(nextSeq(1_760_000_000_500, 1_760_000_000_000)).toBe(1_760_000_000_501);
    });

    it('jumps to the clock when it is ahead of last + 1', () => {
        expect(nextSeq(5, 1_760_000_000_000)).toBe(1_760_000_000_000);
    });

    it('floors fractional milliseconds', () => {
        expect(nextSeq(null, 1_000.9)).toBe(1_000);
        expect(Number.isInteger(nextSeq(3, 2.5))).toBe(true);
    });
});
