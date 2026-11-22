import { beforeEach, describe, expect, it } from 'vitest';

import { cryptoRandom } from '../adapters/crypto-random';
import { newOrgAuditEntryId, type OrgId, type UserId } from '../domain/ids';
import type { WebsiteLicense } from '../domain/licensing/license-contract';
import type { WebsiteLicensingStore } from '../domain/licensing/website-licensing-store';

const NOW = 1_800_000_000_000;
export const CONTRACT_WEBSITE_ORIGIN = 'https://www.ptbk.io';

export interface WebsiteLicensingStoreFixture {
    readonly store: WebsiteLicensingStore;
    /** A fresh organization with its owner, who has this address. */
    addOrg(): Promise<{ readonly orgId: OrgId; readonly userId: UserId; readonly email: string }>;
    /** `website.link` audit entries of the organization, as targets. */
    linkAudit(orgId: OrgId): Promise<readonly string[]>;
}

function subject(): string {
    return crypto.randomUUID();
}

function licenseFor(forSubject: string): WebsiteLicense {
    return {
        snapshot: {
            version: 1,
            subject: forSubject,
            generatedAt: '2026-11-13T00:00:00.000Z',
            refreshAfterSeconds: 900,
            enforcement: 'advisory',
            manageUrl: `${CONTRACT_WEBSITE_ORIGIN}/cs/pricing/predplatne`,
            grants: [],
        },
        status: 'none',
        label: 'Bez aktivní licence',
    };
}

/** One suite, run against the D1 and the in-memory store. */
export function describeWebsiteLicensingStoreContract(
    name: string,
    makeFixture: () => WebsiteLicensingStoreFixture,
): void {
    describe(`WebsiteLicensingStore contract: ${name}`, () => {
        let fixture: WebsiteLicensingStoreFixture;

        beforeEach(() => {
            fixture = makeFixture();
        });

        function link(orgId: OrgId, userId: UserId, linkedSubject: string, at = NOW) {
            return fixture.store.link({
                orgId,
                actorId: userId,
                subject: linkedSubject,
                auditId: newOrgAuditEntryId(cryptoRandom),
                at,
            });
        }

        it('consumes a handoff state once, and never an expired one', async () => {
            const { store } = fixture;
            const hash = crypto.randomUUID();
            await store.createState({ challengeHash: hash, createdAt: NOW, expiresAt: NOW + 1000 });
            expect(await store.consumeState(hash, NOW + 999)).toBe(true);
            expect(await store.consumeState(hash, NOW + 999)).toBe(false);
            const expired = crypto.randomUUID();
            await store.createState({ challengeHash: expired, createdAt: NOW, expiresAt: NOW + 1000 });
            expect(await store.consumeState(expired, NOW + 1000)).toBe(false);
            expect(await store.consumeState(crypto.randomUUID(), NOW)).toBe(false);
        });

        it('drops expired states and pending links when new ones are made', async () => {
            const { store } = fixture;
            const old = crypto.randomUUID();
            await store.createState({ challengeHash: old, createdAt: NOW, expiresAt: NOW + 10 });
            await store.createState({ challengeHash: crypto.randomUUID(), createdAt: NOW + 10, expiresAt: NOW + 20 });
            expect(await store.consumeState(old, 0)).toBe(false);
            const pending = { subject: subject(), email: 'a@example.test', createdAt: NOW, expiresAt: NOW + 10 };
            await store.createPending({ ...pending, tokenHash: 'old' });
            await store.createPending({ ...pending, tokenHash: 'new', createdAt: NOW + 10, expiresAt: NOW + 20 });
            expect(await store.findPending('old', 0)).toBeNull();
        });

        it('finds a pending link until it expires or is deleted', async () => {
            const { store } = fixture;
            const record = {
                tokenHash: crypto.randomUUID(),
                subject: subject(),
                email: 'owner@example.test',
                createdAt: NOW,
                expiresAt: NOW + 1000,
            };
            await store.createPending(record);
            expect(await store.findPending(record.tokenHash, NOW + 999)).toEqual(record);
            expect(await store.findPending(record.tokenHash, NOW + 1000)).toBeNull();
            await store.deletePending(record.tokenHash);
            expect(await store.findPending(record.tokenHash, NOW)).toBeNull();
        });

        it('links one subject to one organization, audited once, and keeps an identical binding', async () => {
            const { orgId, userId, email } = await fixture.addOrg();
            const linked = subject();
            expect(await link(orgId, userId, linked)).toBe('linked');
            expect(await link(orgId, userId, linked, NOW + 1)).toBe('linked');
            expect(await fixture.store.subjectForOrg(orgId)).toBe(linked);
            expect(await fixture.store.linkForOrg(orgId)).toEqual({
                subject: linked,
                linkedAt: NOW,
                linkedByEmail: email,
            });
            expect(await fixture.linkAudit(orgId)).toEqual([linked]);
        });

        it('never re-attaches: another subject for a linked organization, or a subject linked elsewhere', async () => {
            const first = await fixture.addOrg();
            const second = await fixture.addOrg();
            const linked = subject();
            expect(await link(first.orgId, first.userId, linked)).toBe('linked');
            expect(await link(first.orgId, first.userId, subject())).toBe('conflict');
            expect(await link(second.orgId, second.userId, linked)).toBe('conflict');
            expect(await fixture.store.subjectForOrg(first.orgId)).toBe(linked);
            expect(await fixture.store.subjectForOrg(second.orgId)).toBeNull();
            expect(await fixture.store.linkForOrg(second.orgId)).toBeNull();
            expect(await fixture.linkAudit(second.orgId)).toEqual([]);
            expect(await fixture.linkAudit(first.orgId)).toEqual([linked]);
        });

        it('keeps the last licence read per organization, replacing the previous one', async () => {
            const { orgId } = await fixture.addOrg();
            expect(await fixture.store.readLicense(orgId)).toBeNull();
            const first = licenseFor(subject());
            await fixture.store.saveLicense(orgId, first);
            expect(await fixture.store.readLicense(orgId)).toEqual(first);
            const second: WebsiteLicense = {
                snapshot: { ...first.snapshot, refreshAfterSeconds: 60 },
                status: null,
                label: null,
            };
            await fixture.store.saveLicense(orgId, second);
            expect(await fixture.store.readLicense(orgId)).toEqual(second);
        });
    });
}
