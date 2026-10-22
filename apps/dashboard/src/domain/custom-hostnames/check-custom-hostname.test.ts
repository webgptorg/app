import { expectedCnameTarget, Hostname } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    createCustomHostnameFixture,
    CUSTOM_HOSTNAMES_START_MS,
    signClaim,
    TEST_RELAY,
    type CustomHostnameFixture,
} from '../../testing/test-custom-hostnames';
import { createTestEngine } from '../../testing/test-engine';
import { addCustomHostname } from './add-custom-hostname';
import { checkCustomHostname } from './check-custom-hostname';
import { removeCustomHostname } from './remove-custom-hostname';

const HOSTNAME = Hostname.parse('agents.customer.example');
const signal = new AbortController().signal;

describe('checkCustomHostname and removeCustomHostname', () => {
    let fixture: CustomHostnameFixture;

    beforeEach(async () => {
        fixture = await createCustomHostnameFixture();
        const added = await addCustomHostname(
            { ...fixture, customHostnames: fixture.store },
            {
                engineId: fixture.engine.engineId,
                hostname: HOSTNAME,
                claimSig: await signClaim(fixture.engine, HOSTNAME, fixture.engine.engineId),
                adminUserId: fixture.adminUserId,
            },
        );
        expect(added.kind).toBe('added');
        fixture.audit.splice(0);
    });

    const check = (hostname = HOSTNAME) =>
        checkCustomHostname(
            { ...fixture, customHostnames: fixture.store },
            { engineId: fixture.engine.engineId, hostname, adminUserId: fixture.adminUserId },
            signal,
        );
    const expected = () => expectedCnameTarget(fixture.engine.engineId, fixture.engineDomain);
    const status = async () => (await fixture.store.find(fixture.engine.engineId, HOSTNAME))?.status;

    it('activates a hostname whose CNAME is the engine default hostname, and audits it', async () => {
        fixture.dns.setAnswer(HOSTNAME, { kind: 'cname', target: expected() });
        fixture.clock.advance(1000);
        const outcome = await check();
        expect(outcome).toMatchObject({
            kind: 'checked',
            record: { status: 'active', dnsCheckedAt: CUSTOM_HOSTNAMES_START_MS + 1000 },
            lookup: { kind: 'cname', target: expected() },
        });
        expect(await fixture.store.activeCustomHostnames(fixture.engine.engineId)).toEqual([
            { hostname: HOSTNAME, sig: await signClaim(fixture.engine, HOSTNAME, fixture.engine.engineId) },
        ]);
        expect(fixture.audit.map((entry) => [entry.action, entry.targetId])).toEqual([
            ['engine.hostname.activate', `${fixture.engine.engineId}/${HOSTNAME}`],
        ]);
    });

    it.each([
        ['a relay name', () => ({ kind: 'cname', target: TEST_RELAY }) as const],
        ['the engine domain', () => ({ kind: 'cname', target: fixture.engineDomain }) as const],
        ['no CNAME', () => ({ kind: 'none' }) as const],
    ])('keeps pending-dns on %s, records the check and reports what it found', async (_, answer) => {
        fixture.dns.setAnswer(HOSTNAME, answer());
        const outcome = await check();
        expect(outcome).toMatchObject({
            kind: 'checked',
            record: { status: 'pending-dns', dnsCheckedAt: CUSTOM_HOSTNAMES_START_MS },
            lookup: answer(),
        });
        expect(await status()).toBe('pending-dns');
        expect(fixture.audit).toEqual([]);
    });

    it("keeps pending-dns on another engine's default hostname", async () => {
        const other = await createTestEngine();
        fixture.dns.setAnswer(HOSTNAME, {
            kind: 'cname',
            target: expectedCnameTarget(other.engineId, fixture.engineDomain),
        });
        expect(await check()).toMatchObject({ record: { status: 'pending-dns' } });
    });

    it('takes an active hostname back to pending-dns once the CNAME points elsewhere, and audits it', async () => {
        fixture.dns.setAnswer(HOSTNAME, { kind: 'cname', target: expected() });
        await check();
        fixture.dns.setAnswer(HOSTNAME, { kind: 'none' });
        expect(await check()).toMatchObject({ record: { status: 'pending-dns' } });
        expect(fixture.audit.map((entry) => entry.action)).toEqual([
            'engine.hostname.activate',
            'engine.hostname.deactivate',
        ]);
    });

    it('changes nothing when the lookup fails', async () => {
        fixture.dns.setAnswer(HOSTNAME, { kind: 'cname', target: expected() });
        await check();
        fixture.dns.setAnswer(HOSTNAME, { kind: 'error' });
        fixture.clock.advance(1000);
        expect(await check()).toMatchObject({
            kind: 'checked',
            record: { status: 'active', dnsCheckedAt: CUSTOM_HOSTNAMES_START_MS },
            lookup: { kind: 'error' },
        });
        expect(fixture.audit).toHaveLength(1);
    });

    it('answers not-found for a hostname of another engine or none, without a DNS query', async () => {
        const unknown = Hostname.parse('portal.customer.example');
        expect(await check(unknown)).toEqual({ kind: 'not-found' });
        const other = await createTestEngine();
        expect(
            await checkCustomHostname(
                { ...fixture, customHostnames: fixture.store },
                { engineId: other.engineId, hostname: HOSTNAME, adminUserId: fixture.adminUserId },
                signal,
            ),
        ).toEqual({ kind: 'not-found' });
        expect(fixture.dns.queries(HOSTNAME)).toBe(0);
    });

    it('answers not-found when the row is removed during the lookup', async () => {
        const removing = { ...fixture.store, recordDnsCheck: () => Promise.resolve('not-found' as const) };
        fixture.dns.setAnswer(HOSTNAME, { kind: 'cname', target: expected() });
        expect(
            await checkCustomHostname(
                { ...fixture, customHostnames: removing },
                { engineId: fixture.engine.engineId, hostname: HOSTNAME, adminUserId: fixture.adminUserId },
                signal,
            ),
        ).toEqual({ kind: 'not-found' });
    });

    it('removes the row with an audit entry, and answers not-found the second time', async () => {
        const remove = (engineId = fixture.engine.engineId) =>
            removeCustomHostname(
                { ...fixture, customHostnames: fixture.store },
                { engineId, hostname: HOSTNAME, adminUserId: fixture.adminUserId },
            );
        const other = await createTestEngine();
        expect(await remove(other.engineId)).toEqual({ kind: 'not-found' });
        expect(await remove()).toEqual({ kind: 'removed' });
        expect(await fixture.store.listForEngine(fixture.engine.engineId)).toEqual([]);
        expect(await remove()).toEqual({ kind: 'not-found' });
        expect(fixture.audit.map((entry) => [entry.action, entry.targetId])).toEqual([
            ['engine.hostname.remove', `${fixture.engine.engineId}/${HOSTNAME}`],
        ]);
    });
});
