import { beforeEach, describe, expect, it } from 'vitest';

import { cryptoRandom } from '../adapters/crypto-random';
import type { BillingStore, SubscriptionRecord } from '../domain/billing/billing-store';
import { newOrgId, type OrgId } from '../domain/ids';
import type { BillingStatus } from '../shared/billing';

const NOW = 1_800_000_000_000;

export interface BillingStoreFixture {
    readonly store: BillingStore;
    /** Creates an organization (with its owner) the billing rows can point at. */
    addOrg(input?: { readonly name: string | null }): Promise<OrgId>;
}

function unique(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function subscriptionRecord(
    orgId: OrgId,
    overrides: Partial<Omit<SubscriptionRecord, 'orgId'>> = {},
): SubscriptionRecord {
    return {
        orgId,
        subscriptionId: unique('sub'),
        status: 'active',
        priceId: 'price_teststarter',
        quantity: 1,
        currentPeriodEnd: NOW + 30 * 86_400_000,
        cancelAtPeriodEnd: false,
        updatedAt: NOW,
        ...overrides,
    };
}

function event(receivedAt = NOW) {
    return { eventId: unique('evt'), type: 'customer.subscription.updated', receivedAt };
}

/** One suite, run against every {@link BillingStore} adapter (engineering.md, "Adapter" tests). */
export function describeBillingStoreContract(name: string, makeFixture: () => BillingStoreFixture): void {
    describe(`BillingStore contract: ${name}`, () => {
        let fixture: BillingStoreFixture;
        let store: BillingStore;

        beforeEach(() => {
            fixture = makeFixture();
            store = fixture.store;
        });

        describe('customers', () => {
            it('keeps the first customer of an organization and maps it back to the organization', async () => {
                const orgId = await fixture.addOrg();
                const first = unique('cus');
                expect(await store.findCustomer(orgId)).toBeNull();
                expect(await store.saveCustomer(orgId, first, NOW)).toBe(first);
                expect(await store.saveCustomer(orgId, unique('cus'), NOW + 1)).toBe(first);
                expect(await store.findCustomer(orgId)).toBe(first);
                expect(await store.findOrgByCustomer(first)).toBe(orgId);
                expect(await store.findOrgByCustomer(unique('cus'))).toBeNull();
            });

            it('scopes customers by organization and never shares one between two', async () => {
                const orgA = await fixture.addOrg();
                const orgB = await fixture.addOrg();
                const customer = unique('cus');
                await store.saveCustomer(orgA, customer, NOW);
                expect(await store.findCustomer(orgB)).toBeNull();
                await expect(store.saveCustomer(orgB, customer, NOW)).rejects.toThrow();
                expect(await store.findCustomer(orgB)).toBeNull();
            });

            it('refuses a customer for an organization that does not exist', async () => {
                await expect(store.saveCustomer(newOrgId(cryptoRandom), unique('cus'), NOW)).rejects.toThrow();
            });
        });

        describe('events and subscriptions', () => {
            it('records an event with the subscription it carried, scoped by organization', async () => {
                const orgA = await fixture.addOrg();
                const orgB = await fixture.addOrg();
                const received = event();
                const subscription = subscriptionRecord(orgA, { quantity: null, currentPeriodEnd: null });
                expect(await store.hasEvent(received.eventId)).toBe(false);
                await store.recordEvent(received, subscription);
                expect(await store.hasEvent(received.eventId)).toBe(true);
                expect(await store.findSubscription(orgA)).toEqual(subscription);
                expect(await store.findSubscription(orgB)).toBeNull();
            });

            it('records an event without a subscription, and the same event only once', async () => {
                const received = event();
                await store.recordEvent(received, null);
                await store.recordEvent({ ...received, receivedAt: NOW + 5 }, null);
                expect(await store.hasEvent(received.eventId)).toBe(true);
                await store.pruneEvents(NOW + 1);
                expect(await store.hasEvent(received.eventId)).toBe(false);
            });

            it('writes nothing when the subscription points at an unknown organization', async () => {
                const received = event();
                await expect(store.recordEvent(received, subscriptionRecord(newOrgId(cryptoRandom)))).rejects.toThrow();
                expect(await store.hasEvent(received.eventId)).toBe(false);
            });

            it('updates the same subscription only from a fetch at least as new', async () => {
                const orgId = await fixture.addOrg();
                const current = subscriptionRecord(orgId, { updatedAt: NOW + 10 });
                await store.recordEvent(event(), current);
                await store.recordEvent(event(), { ...current, status: 'past_due', updatedAt: NOW + 9 });
                expect(await store.findSubscription(orgId)).toEqual(current);
                const same = { ...current, status: 'past_due' as const, cancelAtPeriodEnd: true };
                await store.recordEvent(event(), same);
                expect(await store.findSubscription(orgId)).toEqual(same);
                const newer = { ...same, status: 'canceled' as const, updatedAt: NOW + 11 };
                await store.recordEvent(event(), newer);
                expect(await store.findSubscription(orgId)).toEqual(newer);
            });

            it.each<[BillingStatus, BillingStatus, boolean]>([
                ['active', 'canceled', false],
                ['past_due', 'none', false],
                ['unpaid', 'canceled', false],
                ['canceled', 'active', true],
                ['canceled', 'canceled', true],
                ['none', 'trialing', true],
                ['active', 'trialing', true],
            ])(
                'with %s stored, another subscription that is %s replaces it: %s',
                async (stored, incoming, replaces) => {
                    const orgId = await fixture.addOrg();
                    const existing = subscriptionRecord(orgId, { status: stored, updatedAt: NOW + 10 });
                    await store.recordEvent(event(), existing);
                    const other = subscriptionRecord(orgId, { status: incoming, priceId: 'price_testscale' });
                    await store.recordEvent(event(), other);
                    expect(await store.findSubscription(orgId)).toEqual(replaces ? other : existing);
                },
            );

            it('prunes only events received before the cut-off', async () => {
                const old = event(NOW - 1);
                const boundary = event(NOW);
                await store.recordEvent(old, null);
                await store.recordEvent(boundary, null);
                await store.pruneEvents(NOW);
                expect(await store.hasEvent(old.eventId)).toBe(false);
                expect(await store.hasEvent(boundary.eventId)).toBe(true);
            });
        });

        it('lists organizations in a problem state, most recently updated first', async () => {
            const statuses: readonly BillingStatus[] = ['active', 'past_due', 'trialing', 'unpaid', 'canceled', 'none'];
            const orgs = await Promise.all(
                statuses.map((_, index) => fixture.addOrg({ name: `Org ${String(index)}` })),
            );
            for (const [index, status] of statuses.entries()) {
                const orgId = orgs[index] as OrgId;
                await store.recordEvent(event(), subscriptionRecord(orgId, { status, updatedAt: NOW + index }));
            }
            const listed = await store.listProblemOrganizations();
            const ours = listed.filter((row) => orgs.includes(row.orgId));
            expect(ours.map((row) => [row.name, row.status])).toEqual([
                ['Org 4', 'canceled'],
                ['Org 3', 'unpaid'],
                ['Org 1', 'past_due'],
            ]);
            expect(ours[0]).toEqual({
                orgId: orgs[4],
                kind: 'personal',
                name: 'Org 4',
                status: 'canceled',
                currentPeriodEnd: NOW + 30 * 86_400_000,
                updatedAt: NOW + 4,
            });
        });
    });
}
