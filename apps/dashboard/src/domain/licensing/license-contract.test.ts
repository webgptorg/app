import { describe, expect, it } from 'vitest';

import { websiteLicenseSchema } from './license-contract';

const ORIGIN = 'https://www.ptbk.io';
const snapshot = {
    version: 1,
    subject: '4408b4d6-6005-4b77-97eb-fdd67847ee92',
    generatedAt: '2026-11-18T20:00:00.000Z',
    refreshAfterSeconds: 900,
    enforcement: 'advisory',
    manageUrl: `${ORIGIN}/cs/pricing/predplatne`,
    grants: [],
};

describe('websiteLicenseSchema', () => {
    const parse = (value: object) => websiteLicenseSchema(ORIGIN).safeParse({ snapshot, ...value }).success;

    it('takes the website’s status and plan name, or neither', () => {
        expect(parse({ status: 'trial', label: 'Business – zkušební období' })).toBe(true);
        expect(parse({ status: null, label: null })).toBe(true);
    });

    it('refuses a plan name that could be markup or hide control characters, and unknown statuses', () => {
        expect(parse({ status: 'active', label: '<b>Business</b>' })).toBe(false);
        expect(parse({ status: 'active', label: 'Busi\u0000ness' })).toBe(false);
        expect(parse({ status: 'active', label: '' })).toBe(false);
        expect(parse({ status: 'active', label: 'x'.repeat(161) })).toBe(false);
        expect(parse({ status: 'paid', label: null })).toBe(false);
    });

    it('refuses a manage link off the website, as the snapshot alone does', () => {
        expect(
            websiteLicenseSchema(ORIGIN).safeParse({
                snapshot: { ...snapshot, manageUrl: 'https://evil.example/' },
                status: null,
                label: null,
            }).success,
        ).toBe(false);
    });
});
