import { describe, expect, it, vi } from 'vitest';

import { createMemoryWebsiteLicensingStore } from '../../testing/memory-website-licensing-store';
import { sha256Hex } from '../auth/secrets';
import { newOrgId, newUserId } from '../ids';
import { createWebsiteAccessFlows, HANDOFF_STATE_TTL_MS, PENDING_LINK_TTL_MS } from './website-access';
import type { WebsiteIdentity } from './website-handoff';

const CODE = 'c'.repeat(43);
const cryptoRandom = { bytes: (length: number) => crypto.getRandomValues(new Uint8Array(length)) };
const identity: WebsiteIdentity = {
    subject: '4408b4d6-6005-4b77-97eb-fdd67847ee92',
    email: 'Owner@Example.test',
    emailVerified: true,
};

function setup(options: { readonly exchanged?: WebsiteIdentity | null; readonly existing?: readonly string[] } = {}) {
    let now = 1_800_000_000_000;
    const store = createMemoryWebsiteLicensingStore();
    const exchange = vi.fn().mockResolvedValue(options.exchanged === undefined ? identity : options.exchanged);
    const flows = createWebsiteAccessFlows({
        clock: { nowMs: () => now },
        random: cryptoRandom,
        handoffs: store,
        websiteLinks: store,
        exchange: { exchange },
        accounts: {
            findUserByEmail: (email) => Promise.resolve((options.existing ?? []).includes(email) ? {} : null),
        },
    });
    const signal = new AbortController().signal;
    return {
        store,
        exchange,
        flows,
        signal,
        advance: (ms: number) => {
            now += ms;
        },
        actor: (email = 'owner@example.test') => ({
            userId: newUserId(cryptoRandom),
            email,
            orgId: newOrgId(cryptoRandom),
        }),
        pendingToken: async () => {
            const { challenge } = await flows.start();
            const outcome = await flows.complete({ code: CODE, challenge }, signal);
            if (outcome.kind !== 'pending') throw new Error(outcome.kind);
            return outcome.token;
        },
    };
}

describe('website access handoff', () => {
    it('stores only the hash of a fresh 256-bit challenge, for ten minutes', async () => {
        const { flows, store } = setup();
        const first = await flows.start();
        const second = await flows.start();
        expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(second.challenge).not.toBe(first.challenge);
        expect(store.states.get(await sha256Hex(first.challenge))).toBe(first.expiresAt);
        expect([...store.states.keys()]).not.toContain(first.challenge);
        expect(first.expiresAt - 1_800_000_000_000).toBe(HANDOFF_STATE_TTL_MS);
    });

    it('exchanges the code with the challenge from this browser, then holds the identity behind a new cookie', async () => {
        const { flows, exchange, store, signal } = setup();
        const { challenge } = await flows.start();
        const outcome = await flows.complete({ code: CODE, challenge }, signal);
        expect(exchange).toHaveBeenCalledWith({ code: CODE, challenge }, signal);
        if (outcome.kind !== 'pending') throw new Error(outcome.kind);
        expect(outcome.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(outcome.token).not.toBe(challenge);
        expect(store.pending.get(await sha256Hex(outcome.token))).toMatchObject({
            subject: identity.subject,
            email: 'owner@example.test',
            expiresAt: outcome.expiresAt,
        });
        expect(outcome.expiresAt - 1_800_000_000_000).toBe(PENDING_LINK_TTL_MS);
    });

    it('spends the state of an abandoned handoff without calling the website', async () => {
        const { flows, exchange, store, signal } = setup();
        const { challenge } = await flows.start();
        await flows.abandon(challenge);
        await flows.abandon(null);
        expect(store.states.size).toBe(0);
        expect(await flows.complete({ code: CODE, challenge }, signal)).toEqual({ kind: 'state-invalid' });
        expect(exchange).not.toHaveBeenCalled();
    });

    it('fails closed without the state cookie, on a replay, after expiry and on a challenge it never issued', async () => {
        const { flows, exchange, signal, advance } = setup();
        expect(await flows.complete({ code: CODE, challenge: null }, signal)).toEqual({ kind: 'state-invalid' });
        expect(await flows.complete({ code: CODE, challenge: 'f'.repeat(43) }, signal)).toEqual({
            kind: 'state-invalid',
        });
        const { challenge } = await flows.start();
        expect((await flows.complete({ code: CODE, challenge }, signal)).kind).toBe('pending');
        expect(await flows.complete({ code: CODE, challenge }, signal)).toEqual({ kind: 'state-invalid' });
        const late = await flows.start();
        advance(HANDOFF_STATE_TTL_MS);
        expect(await flows.complete({ code: CODE, challenge: late.challenge }, signal)).toEqual({
            kind: 'state-invalid',
        });
        expect(exchange).toHaveBeenCalledTimes(1);
    });

    it('fails closed on a forged, replayed or expired ticket, which the website refuses, and spends the state', async () => {
        const { flows, store, signal } = setup({ exchanged: null });
        const { challenge } = await flows.start();
        expect(await flows.complete({ code: CODE, challenge }, signal)).toEqual({ kind: 'exchange-failed' });
        expect(store.pending.size).toBe(0);
        expect(await flows.complete({ code: CODE, challenge }, signal)).toEqual({ kind: 'state-invalid' });
    });

    it('tells the holder of the pending cookie whether to sign in or sign up, until it expires', async () => {
        const existing = setup({ existing: ['owner@example.test'] });
        const token = await existing.pendingToken();
        expect(await existing.flows.pending(token)).toEqual({
            kind: 'pending',
            email: 'owner@example.test',
            accountExists: true,
            expiresAt: expect.any(Number) as number,
        });
        existing.advance(PENDING_LINK_TTL_MS);
        expect(await existing.flows.pending(token)).toEqual({ kind: 'none' });
        const fresh = setup();
        expect(await fresh.flows.pending(await fresh.pendingToken())).toMatchObject({ accountExists: false });
        expect(await fresh.flows.pending(null)).toEqual({ kind: 'none' });
        expect(await fresh.flows.pending('x'.repeat(43))).toEqual({ kind: 'none' });
    });

    it('links the active organization for the matching account, audited, and forgets the pending link', async () => {
        const { flows, store, pendingToken } = setup();
        const token = await pendingToken();
        const actor = setup().actor('OWNER@example.test');
        expect(await flows.link({ token, actor })).toBe('linked');
        expect(store.links.get(actor.orgId)).toMatchObject({ subject: identity.subject, linkedByUserId: actor.userId });
        expect(store.audit).toEqual([expect.objectContaining({ orgId: actor.orgId, action: 'website.link' })]);
        expect(store.pending.size).toBe(0);
        expect(await flows.link({ token, actor })).toBe('pending-invalid');
    });

    it('refuses another account, keeping the pending link for the right one', async () => {
        const { flows, store, pendingToken, actor } = setup();
        const token = await pendingToken();
        expect(await flows.link({ token, actor: actor('someone-else@example.test') })).toBe('email-mismatch');
        expect(store.links.size).toBe(0);
        expect(await flows.link({ token, actor: actor() })).toBe('linked');
    });

    it('refuses a subject already linked to another organization, and an organization linked to another subject', async () => {
        const { flows, store, pendingToken, actor } = setup();
        const first = actor();
        expect(await flows.link({ token: await pendingToken(), actor: first })).toBe('linked');
        expect(await flows.link({ token: await pendingToken(), actor: actor() })).toBe('conflict');
        store.links.set(first.orgId, { subject: crypto.randomUUID(), linkedByUserId: first.userId, linkedAt: 0 });
        expect(await flows.link({ token: await pendingToken(), actor: first })).toBe('conflict');
        expect(await flows.link({ token: null, actor: first })).toBe('pending-invalid');
    });
});
