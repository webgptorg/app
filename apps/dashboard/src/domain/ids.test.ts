import { describe, expect, it } from 'vitest';

import { newOrgId, newUserId, orgIdSchema } from './ids';

describe('ids', () => {
    it('generates 26-character lowercase base32 ids from 128 random bits', () => {
        let counter = 0;
        const random = { bytes: (n: number) => Uint8Array.from({ length: n }, () => counter++ & 0xff) };
        const first = newOrgId(random);
        const second = newUserId(random);
        expect(first).toMatch(/^[a-z2-7]{26}$/);
        expect(second).toMatch(/^[a-z2-7]{26}$/);
        expect(first).not.toBe(second);
        expect(newOrgId({ bytes: (n) => new Uint8Array(n) })).toBe('a'.repeat(26));
        expect(newOrgId({ bytes: (n) => new Uint8Array(n).fill(255) })).toBe(`${'7'.repeat(25)}4`);
    });

    it('rejects anything else', () => {
        expect(orgIdSchema.safeParse('A'.repeat(26)).success).toBe(false);
        expect(orgIdSchema.safeParse('a'.repeat(25)).success).toBe(false);
    });
});
