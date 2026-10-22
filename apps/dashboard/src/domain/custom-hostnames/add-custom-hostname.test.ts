import { Hostname } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    createCustomHostnameFixture,
    CUSTOM_HOSTNAMES_START_MS,
    signClaim,
    type CustomHostnameFixture,
} from '../../testing/test-custom-hostnames';
import { createTestEngine } from '../../testing/test-engine';
import { addCustomHostname, MAX_CUSTOM_HOSTNAMES } from './add-custom-hostname';

const HOSTNAME = 'agents.customer.example';

describe('addCustomHostname', () => {
    let fixture: CustomHostnameFixture;

    beforeEach(async () => {
        fixture = await createCustomHostnameFixture();
    });

    const add = async (hostname: string, claimSig?: Parameters<typeof addCustomHostname>[1]['claimSig']) =>
        addCustomHostname(
            { ...fixture, customHostnames: fixture.store },
            {
                engineId: fixture.engine.engineId,
                hostname,
                claimSig: claimSig ?? (await signClaim(fixture.engine, HOSTNAME, fixture.engine.engineId)),
                adminUserId: fixture.adminUserId,
            },
        );

    it('stores a hostname whose claim the engine key signed as pending-dns, and audits it', async () => {
        const outcome = await add(HOSTNAME);
        const record = {
            hostname: Hostname.parse(HOSTNAME),
            engineId: fixture.engine.engineId,
            orgId: fixture.orgId,
            claimSig: await signClaim(fixture.engine, HOSTNAME, fixture.engine.engineId),
            status: 'pending-dns',
            dnsCheckedAt: null,
            createdAt: CUSTOM_HOSTNAMES_START_MS,
            createdByUserId: fixture.adminUserId,
        };
        expect(outcome).toEqual({ kind: 'added', record });
        expect(await fixture.store.listForEngine(fixture.engine.engineId)).toEqual([record]);
        expect(await fixture.store.activeCustomHostnames(fixture.engine.engineId)).toEqual([]);
        expect(fixture.audit).toEqual([
            {
                id: expect.stringMatching(/^[a-z2-7]{26}$/) as unknown,
                adminUserId: fixture.adminUserId,
                action: 'engine.hostname.add',
                targetType: 'engine-hostname',
                targetId: `${fixture.engine.engineId}/${HOSTNAME}`,
                reason: null,
                createdAt: CUSTOM_HOSTNAMES_START_MS,
            },
        ]);
    });

    it('verifies the claim over the normalised hostname', async () => {
        const outcome = await add('Agents.Customer.Example.');
        expect(outcome.kind === 'added' && outcome.record.hostname).toBe(HOSTNAME);
    });

    it('answers invalid-hostname before looking anything up', async () => {
        expect(await add('*.customer.example')).toEqual({ kind: 'invalid-hostname' });
        expect(await add('192.0.2.1')).toEqual({ kind: 'invalid-hostname' });
        expect(fixture.audit).toEqual([]);
    });

    it.each([
        ['a subdomain of the engine domain', 'agents.engines.ptbk.test'],
        ['the engine domain itself', 'engines.ptbk.test'],
        ['a name under ptbk.io', 'customer.ptbk.io'],
        ['a relay hostname', 'relay-1.ptbk.test'],
        ['a name under a relay hostname', 'x.relay-1.ptbk.test'],
    ])('answers reserved-domain for %s', async (_, hostname) => {
        expect(await add(hostname, await signClaim(fixture.engine, hostname, fixture.engine.engineId))).toEqual({
            kind: 'reserved-domain',
        });
    });

    it('answers engine-not-found for an engine nobody registered', async () => {
        const stranger = await createTestEngine();
        const outcome = await addCustomHostname(
            { ...fixture, customHostnames: fixture.store },
            {
                engineId: stranger.engineId,
                hostname: HOSTNAME,
                claimSig: await signClaim(stranger, HOSTNAME, stranger.engineId),
                adminUserId: fixture.adminUserId,
            },
        );
        expect(outcome).toEqual({ kind: 'engine-not-found' });
    });

    it('answers taken for a hostname any engine already has, in any status', async () => {
        expect((await add(HOSTNAME)).kind).toBe('added');
        expect(await add(HOSTNAME)).toEqual({ kind: 'taken' });
        expect(fixture.audit).toHaveLength(1);
    });

    it('answers taken when another write wins between the check and the insert', async () => {
        const racing = {
            ...fixture.store,
            isAssigned: () => Promise.resolve(false),
            insert: () => Promise.resolve('taken' as const),
        };
        const outcome = await addCustomHostname(
            { ...fixture, customHostnames: racing },
            {
                engineId: fixture.engine.engineId,
                hostname: HOSTNAME,
                claimSig: await signClaim(fixture.engine, HOSTNAME, fixture.engine.engineId),
                adminUserId: fixture.adminUserId,
            },
        );
        expect(outcome).toEqual({ kind: 'taken' });
    });

    it('answers bad-claim for a claim signed by another key', async () => {
        const other = await createTestEngine();
        expect(await add(HOSTNAME, await signClaim(other, HOSTNAME, fixture.engine.engineId))).toEqual({
            kind: 'bad-claim',
        });
    });

    it('answers bad-claim for a claim for a different hostname', async () => {
        const claim = await signClaim(fixture.engine, 'portal.customer.example', fixture.engine.engineId);
        expect(await add(HOSTNAME, claim)).toEqual({ kind: 'bad-claim' });
    });

    it('answers bad-claim for a claim for a different engine ID', async () => {
        const other = await createTestEngine();
        expect(await add(HOSTNAME, await signClaim(fixture.engine, HOSTNAME, other.engineId))).toEqual({
            kind: 'bad-claim',
        });
        expect(fixture.audit).toEqual([]);
        expect(await fixture.store.listForEngine(fixture.engine.engineId)).toEqual([]);
    });

    it('answers limit-reached once the registry entry would be full', async () => {
        for (let index = 0; index < MAX_CUSTOM_HOSTNAMES; index++) {
            const hostname = `h${String(index)}.customer.example`;
            const outcome = await add(hostname, await signClaim(fixture.engine, hostname, fixture.engine.engineId));
            expect(outcome.kind).toBe('added');
        }
        expect(await add(HOSTNAME)).toEqual({ kind: 'limit-reached' });
    });
});
