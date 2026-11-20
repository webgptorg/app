import { describe, expect, it } from 'vitest';

import { createFakeWebsiteLicenseApi, BUSINESS_CAPABILITIES } from '../../testing/fake-website-license-api';
import { createMemoryWebsiteLicensingStore } from '../../testing/memory-website-licensing-store';
import type { OrgId, UserId } from '../ids';
import type { LicenseEnforcement } from './license-checks';
import { createLicenseService, OPEN_LICENSE_GATE } from './license-service';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const SUBJECT = '4408b4d6-6005-4b77-97eb-fdd67847ee92';
const ORG = 'org-1' as OrgId;
const signal = new AbortController().signal;

function setup(mode: LicenseEnforcement, engines: number, linked = true) {
    const store = createMemoryWebsiteLicensingStore(() => 'ada@example.test');
    if (linked) store.links.set(ORG, { subject: SUBJECT, linkedByUserId: 'user-1' as UserId, linkedAt: NOW });
    const website = createFakeWebsiteLicenseApi({ nowMs: () => NOW });
    website.set(SUBJECT, {
        grants: [
            {
                id: '4408b4d6-6005-4b77-97eb-fdd67847ee93',
                validFrom: '2026-11-01T00:00:00.000Z',
                validUntil: '2026-12-01T00:00:00.000Z',
                capabilities: BUSINESS_CAPABILITIES,
            },
        ],
        status: 'active',
        label: 'Business',
    });
    const service = createLicenseService({
        mode,
        api: website.api,
        store,
        engines: { countActive: () => Promise.resolve(engines) },
        teams: { listOrgMembers: () => Promise.resolve([{} as never, {} as never]) },
        clock: { nowMs: () => NOW },
    });
    return { service, website };
}

describe('createLicenseService', () => {
    it('shows the plan, its term and how each check point would answer now', async () => {
        const { service } = setup('advisory', 1);
        const overview = await service.overview(ORG, signal);
        expect(overview.link).toMatchObject({ subject: SUBJECT, linkedByEmail: 'ada@example.test' });
        expect(overview.summary).toMatchObject({
            status: 'active',
            label: 'Business',
            term: { kind: 'ends', at: '2026-12-01T00:00:00.000Z' },
            coverage: { engines: { used: 1, covered: 1, capacity: 1 }, people: { used: 2, limit: 5 } },
        });
        expect(overview.checks).toEqual({
            'engine.link': { outcome: 'warn', reason: 'over-limit' },
            'member.invite': { outcome: 'ok' },
        });
    });

    it('advisory: the gate lets everything through without asking the website', async () => {
        const { service, website } = setup('advisory', 1);
        expect(await service.gate.check('engine.link', ORG, signal)).toEqual({ outcome: 'ok' });
        expect(await service.gate.check('member.invite', ORG, signal, 10)).toEqual({ outcome: 'ok' });
        expect(website.lookups).toEqual([]);
    });

    it('enforce: the gate denies beyond the licence and lets the rest through', async () => {
        const full = setup('enforce', 1);
        expect(await full.service.gate.check('engine.link', ORG, signal)).toEqual({
            outcome: 'deny',
            reason: 'over-limit',
        });
        expect(await full.service.gate.check('member.invite', ORG, signal, 3)).toEqual({ outcome: 'ok' });
        expect(await full.service.gate.check('member.invite', ORG, signal, 4)).toEqual({
            outcome: 'deny',
            reason: 'over-limit',
        });
        const room = setup('enforce', 0);
        expect(await room.service.gate.check('engine.link', ORG, signal)).toEqual({ outcome: 'ok' });
    });

    it('enforce: a website outage never denies', async () => {
        const { service, website } = setup('enforce', 1);
        website.outage = true;
        expect(await service.gate.check('engine.link', ORG, signal)).toEqual({ outcome: 'ok' });
    });

    it('enforce: an organization without a linked account is denied a new engine', async () => {
        const { service, website } = setup('enforce', 0, false);
        expect(await service.gate.check('engine.link', ORG, signal)).toEqual({ outcome: 'deny', reason: 'unlinked' });
        expect(website.lookups).toEqual([]);
    });

    it('has an open gate for dashboards without website licences', async () => {
        expect(await OPEN_LICENSE_GATE.check('engine.link', ORG, signal)).toEqual({ outcome: 'ok' });
    });
});
