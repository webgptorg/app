import { describe, expect, it } from 'vitest';

import type { LicenseGrant, LicenseSnapshot, WebsiteLicense, WebsiteLicenseStatus } from './license-contract';
import { summarizeLicense } from './license-summary';

const now = Date.parse('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;

function grant(
    id: string,
    capabilities: Partial<LicenseGrant['capabilities']> = {},
    validity: Partial<Pick<LicenseGrant, 'validFrom' | 'validUntil'>> = {},
): LicenseGrant {
    return {
        id,
        validFrom: new Date(now - DAY).toISOString(),
        validUntil: null,
        ...validity,
        capabilities: {
            engineProjects: 1,
            specialists: 10,
            controllingUsers: 5,
            harnessInstances: null,
            browserProfiles: 5,
            remoteControl: true,
            ...capabilities,
        },
    };
}

function snapshot(grants: readonly LicenseGrant[]): LicenseSnapshot {
    return {
        version: 1,
        subject: '4408b4d6-6005-4b77-97eb-fdd67847ee92',
        generatedAt: '2026-11-16T10:00:00.000Z',
        refreshAfterSeconds: 900,
        enforcement: 'advisory',
        manageUrl: 'https://www.ptbk.io/cs/pricing/predplatne',
        grants: [...grants],
    };
}

function license(
    grants: readonly LicenseGrant[],
    website: { readonly status?: WebsiteLicenseStatus; readonly label?: string } = {},
): WebsiteLicense {
    return { snapshot: snapshot(grants), status: website.status ?? null, label: website.label ?? null };
}

const current = (grants: readonly LicenseGrant[], website?: Parameters<typeof license>[1]) =>
    ({ kind: 'current', license: license(grants, website) }) as const;

describe('summarizeLicense', () => {
    it('asks an unlinked organization to link, and shows nothing it does not know for a linked one', () => {
        const usage = { engines: 2, people: 3 };
        expect(summarizeLicense({ linked: false, read: { kind: 'unknown' }, usage, now })).toEqual({
            state: 'unknown',
            status: null,
            label: null,
            term: null,
            checkedAt: null,
            manageUrl: null,
            grants: [],
            coverage: null,
            notice: 'unlinked',
        });
        expect(summarizeLicense({ linked: true, read: { kind: 'unknown' }, usage, now }).notice).toBeNull();
    });

    it('covers engines with several heterogeneous grants and sums their project capacity', () => {
        const summary = summarizeLicense({
            linked: true,
            read: current([
                grant('start', { engineProjects: 1, controllingUsers: 2 }),
                grant('business', { engineProjects: 3 }),
            ]),
            usage: { engines: 3, people: 2 },
            now,
        });
        expect(summary.state).toBe('current');
        expect(summary.checkedAt).toBe('2026-11-16T10:00:00.000Z');
        expect(summary.manageUrl).toBe('https://www.ptbk.io/cs/pricing/predplatne');
        expect(summary.coverage).toEqual({
            engines: { used: 3, covered: 3, capacity: 4 },
            people: { used: 2, limit: 5 },
        });
        expect(summary.grants.map((g) => g.active)).toEqual([true, true]);
        expect(summary.notice).toBeNull();
    });

    it('keeps unlimited capacities unlimited instead of summing them into a number', () => {
        const summary = summarizeLicense({
            linked: true,
            read: current([grant('unlimited', { engineProjects: null, controllingUsers: null }), grant('small')]),
            usage: { engines: 12, people: 40 },
            now,
        });
        expect(summary.coverage).toEqual({
            engines: { used: 12, covered: 12, capacity: null },
            people: { used: 40, limit: null },
        });
        expect(summary.notice).toBeNull();
    });

    it('notices more engines, or more people, than the grants cover, without blocking anything', () => {
        expect(
            summarizeLicense({ linked: true, read: current([grant('one')]), usage: { engines: 2, people: 1 }, now }),
        ).toMatchObject({ notice: 'exceeded', coverage: { engines: { used: 2, covered: 1, capacity: 1 } } });
        expect(
            summarizeLicense({ linked: true, read: current([grant('one')]), usage: { engines: 1, people: 6 }, now }),
        ).toMatchObject({ notice: 'exceeded', coverage: { engines: { covered: 0 }, people: { used: 6, limit: 5 } } });
    });

    it('notices an expired trial apart from no licence at all, and stays quiet without engines', () => {
        const trial = grant(
            'trial',
            {},
            { validFrom: new Date(now - 15 * DAY).toISOString(), validUntil: new Date(now - DAY).toISOString() },
        );
        const expired = summarizeLicense({
            linked: true,
            read: current([trial]),
            usage: { engines: 1, people: 1 },
            now,
        });
        expect(expired.notice).toBe('expired');
        expect(expired.grants).toEqual([{ ...trial, active: false }]);
        expect(expired.coverage).toEqual({
            engines: { used: 1, covered: 0, capacity: 0 },
            people: { used: 1, limit: 0 },
        });
        const future = grant('future', {}, { validFrom: new Date(now + DAY).toISOString() });
        expect(
            summarizeLicense({ linked: true, read: current([future]), usage: { engines: 1, people: 1 }, now }).notice,
        ).toBe('missing');
        expect(
            summarizeLicense({ linked: true, read: current([]), usage: { engines: 1, people: 1 }, now }).notice,
        ).toBe('missing');
        expect(
            summarizeLicense({ linked: true, read: current([]), usage: { engines: 0, people: 1 }, now }).notice,
        ).toBeNull();
    });

    it('shows the last snapshot during an outage as stale, with when it was checked', () => {
        const summary = summarizeLicense({
            linked: true,
            read: { kind: 'stale', license: license([grant('one')]) },
            usage: { engines: 1, people: 1 },
            now,
        });
        expect(summary).toMatchObject({ state: 'stale', checkedAt: '2026-11-16T10:00:00.000Z', notice: null });
    });

    describe('status, plan name and term', () => {
        const at = (days: number) => new Date(now + days * DAY).toISOString();
        const summary = (read: ReturnType<typeof current>) =>
            summarizeLicense({ linked: true, read, usage: { engines: 1, people: 1 }, now });

        it('is active until the last active grant ends, and has no end while any grant is open-ended', () => {
            expect(
                summary(
                    current([grant('b', {}, { validUntil: at(10) }), grant('a', {}, { validUntil: at(3) })], {
                        label: 'Business',
                    }),
                ),
            ).toMatchObject({ status: 'active', label: 'Business', term: { kind: 'ends', at: at(10) } });
            expect(summary(current([grant('a', {}, { validUntil: at(3) }), grant('open')]))).toMatchObject({
                status: 'active',
                label: null,
                term: null,
            });
        });

        it('takes a trial from the website, but only while a grant is active', () => {
            const trial = grant('trial', {}, { validUntil: at(14) });
            expect(summary(current([trial], { status: 'trial' }))).toMatchObject({
                status: 'trial',
                term: { kind: 'ends', at: at(14) },
            });
            const ended = grant('trial', {}, { validFrom: at(-15), validUntil: at(-1) });
            expect(summary(current([ended], { status: 'trial' }))).toMatchObject({
                status: 'expired',
                term: { kind: 'ended', at: at(-1) },
                notice: 'expired',
            });
        });

        it('says when a future grant starts, and when the last one ended', () => {
            expect(
                summary(current([grant('sooner', {}, { validFrom: at(5) }), grant('later', {}, { validFrom: at(9) })])),
            ).toMatchObject({
                status: 'scheduled',
                term: { kind: 'starts', at: at(5) },
            });
            expect(
                summary(
                    current([
                        grant('old', {}, { validFrom: at(-40), validUntil: at(-20) }),
                        grant('newer', {}, { validFrom: at(-20), validUntil: at(-2) }),
                    ]),
                ),
            ).toMatchObject({ status: 'expired', term: { kind: 'ended', at: at(-2) } });
        });

        it('trusts the website for an ended or future licence it sends without grants, and is none otherwise', () => {
            expect(summary(current([], { status: 'expired' }))).toMatchObject({
                status: 'expired',
                term: null,
                notice: 'expired',
            });
            expect(summary(current([], { status: 'scheduled' }))).toMatchObject({ status: 'scheduled', term: null });
            expect(summary(current([], { status: 'active' }))).toMatchObject({ status: 'none', notice: 'missing' });
            expect(summary(current([]))).toMatchObject({ status: 'none', term: null });
        });
    });
});
