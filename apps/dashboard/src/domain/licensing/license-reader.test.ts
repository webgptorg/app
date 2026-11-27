import { describe, expect, it } from 'vitest';

import { BUSINESS_CAPABILITIES, createFakeWebsiteLicenseApi } from '../../testing/fake-website-license-api';
import type { WebsiteLicense, WebsiteLicenseApi, WebsiteLicenseStore } from './license-contract';
import { createLicenseReader } from './license-reader';

const SUBJECT = '4408b4d6-6005-4b77-97eb-fdd67847ee92';
const OTHER = '4408b4d6-6005-4b77-97eb-fdd67847ee93';
const START = Date.parse('2026-11-13T00:00:00.000Z');
const signal = new AbortController().signal;
const grant = {
    id: '4408b4d6-6005-4b77-97eb-fdd67847ee94',
    validFrom: '2026-11-01T00:00:00.000Z',
    validUntil: null,
    capabilities: BUSINESS_CAPABILITIES,
};

function setup(subject: string | null = SUBJECT) {
    let now = START;
    const website = createFakeWebsiteLicenseApi({ nowMs: () => now });
    website.set(SUBJECT, { grants: [grant], status: 'active', label: 'Business' });
    const saved = new Map<string, WebsiteLicense>();
    const store: WebsiteLicenseStore = {
        subjectForOrg: () => Promise.resolve(subject),
        readLicense: (orgId) => Promise.resolve(saved.get(orgId) ?? null),
        saveLicense: (orgId, license) => {
            saved.set(orgId, license);
            return Promise.resolve();
        },
    };
    const make = (api: WebsiteLicenseApi = website.api) => createLicenseReader({ api, store, nowMs: () => now });
    return {
        website,
        saved,
        make,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

describe('createLicenseReader', () => {
    it('leaves an organization without a linked account unknown, without asking the website', async () => {
        const { make, website } = setup(null);
        expect(await make().read('org', signal)).toEqual({ kind: 'unknown' });
        expect(website.lookups).toEqual([]);
    });

    it('fetches, stores and then serves the stored licence until refreshAfterSeconds', async () => {
        const { make, website, saved, advance } = setup();
        const first = await make().read('org', signal);
        expect(first).toMatchObject({ kind: 'current', license: { status: 'active', label: 'Business' } });
        expect(saved.get('org')).toEqual(first.kind === 'unknown' ? null : first.license);
        advance(899_000);
        expect((await make().read('org', signal)).kind).toBe('current');
        expect(website.lookups).toEqual([SUBJECT]);
        advance(2_000);
        await make().read('org', signal);
        expect(website.lookups).toEqual([SUBJECT, SUBJECT]);
    });

    it('keeps the stored licence as stale through an outage, and is unknown without one', async () => {
        const { make, website, advance } = setup();
        const first = await make().read('org', signal);
        advance(901_000);
        website.outage = true;
        expect(await make().read('org', signal)).toEqual({
            kind: 'stale',
            license: first.kind === 'unknown' ? null : first.license,
        });
        expect(await make().read('other-org', signal)).toEqual({ kind: 'unknown' });
    });

    it('refuses an answer for another account or from the future, and never stores it', async () => {
        const { make, saved } = setup();
        const fake = createFakeWebsiteLicenseApi({ nowMs: () => START });
        fake.set(SUBJECT, { grants: [grant] });
        const answersFor = (subject: string, generatedAt: number): WebsiteLicenseApi => ({
            lookup: async (account, abort) => {
                const license = await fake.api.lookup(account, abort);
                return {
                    ...license,
                    snapshot: { ...license.snapshot, subject, generatedAt: new Date(generatedAt).toISOString() },
                };
            },
        });
        expect(await make(answersFor(OTHER, START)).read('org', signal)).toEqual({ kind: 'unknown' });
        expect(await make(answersFor(SUBJECT, START + 120_001)).read('org', signal)).toEqual({ kind: 'unknown' });
        expect(saved.size).toBe(0);
    });

    it('drops a stored licence of another account, even during an outage', async () => {
        const { make, website, saved } = setup();
        await make().read('org', signal);
        const stored = saved.get('org');
        if (stored === undefined) throw new Error('nothing stored');
        saved.set('org', { ...stored, snapshot: { ...stored.snapshot, subject: OTHER } });
        website.outage = true;
        expect(await make().read('org', signal)).toEqual({ kind: 'unknown' });
    });
});
