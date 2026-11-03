import type { EngineApiClient, Member } from '@ptbk/engine-api';
import {
    MAX_ACCESS_CODE_ATTEMPTS,
    MAX_PENDING_ACCESS_REQUESTS,
    PERMISSIONS,
    createEngineApiClient,
} from '@ptbk/engine-api';
import type { AccessTicket, Signer } from '@ptbk/protocol';
import {
    EngineId as EngineIdSchema,
    MEMBER_REVOCATION_MAX_SKEW_MS,
    Timestamp,
    createWebCryptoSigner,
    generateEd25519KeyPair,
    signAccessTicket,
    signMemberRevocation,
} from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { createFakeCeremonies } from '../../testing/fake-passkey-ceremonies';
import { createMemoryLogger } from '../../testing/memory-logger';
import { createSeededRandom } from '../../testing/seeded-random';
import { createTestRuntime } from '../../testing/test-runtime';
import type { RelyingParty } from './passkey-ceremonies';
import { createChallenges } from './passkey-ceremonies';
import { createInMemoryPasskeyStore } from './passkey-gateway';
import { createJoinGateway } from './join-gateway';
import { createSessionStore } from './sessions';
import { createInMemorySpentTickets } from './spent-tickets';
import type { SpentTicketStore } from './spent-tickets';

const ENGINE_ID = EngineIdSchema.parse('abcdefghijklmnopqrstuvwxyz');
const OTHER_ENGINE = EngineIdSchema.parse('bbbbbbbbbbbbbbbbbbbbbbbbbb');
const HOSTNAME = `${ENGINE_ID}.engines.ptbk.test`;
const RP: RelyingParty = { id: HOSTNAME, origin: `https://${HOSTNAME}` };
const CLIENT = { ip: '203.0.113.9', userAgent: 'test browser' };
const NOW = Date.parse('2026-10-30T10:00:00Z');
const SIGNAL = new AbortController().signal;

const iso = (ms: number) => Timestamp.parse(new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));

async function setup(options: { readonly pinned?: boolean; readonly spentTickets?: () => SpentTicketStore } = {}) {
    const clock = createFakeClock(NOW);
    const runtime = await createTestRuntime({
        seed: 7,
        scenario: 'small-team',
        epoch: new Date('2026-10-01T00:00:00Z'),
        identity: { engineId: ENGINE_ID, hostname: HOSTNAME, mode: 'tunnel', version: '0.1.0' },
        clock,
        passkeys: 'none',
    });
    const random = createSeededRandom(13);
    const memberSigner = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
    const ceremonies = createFakeCeremonies();
    const passkeys = createInMemoryPasskeyStore();
    const sessions = createSessionStore({ engine: () => runtime.controller(), clock, random });
    const logger = createMemoryLogger();
    const spentTickets = options.spentTickets ?? createInMemorySpentTickets;
    /** A new gateway over the same engine, as after a restart: only what its stores persisted is left. */
    const startGateway = () =>
        createJoinGateway({
            engine: () => runtime.controller(),
            engineId: ENGINE_ID,
            memberKey: () => (options.pinned === false ? null : memberSigner.publicKey()),
            passkeys,
            spentTickets: spentTickets(),
            sessions,
            ceremonies,
            challenges: createChallenges({ random, clock }),
            random,
            clock,
            engineNowMs: () => runtime.clock.nowMs(),
            logger,
        });
    const join = startGateway();
    let ids = 0;
    const nextId = () => `ticket-${String(++ids).padStart(12, '0')}`;

    function ticket(overrides: Partial<AccessTicket> = {}, signer: Signer = memberSigner): Promise<string> {
        const issuedAt = clock.nowMs();
        return signAccessTicket(signer, {
            v: 1,
            engineId: ENGINE_ID,
            ticketId: nextId(),
            dashboardUserId: `user-${String(ids)}`,
            displayName: 'Dana Novak',
            email: 'dana@example.com',
            proposedRole: 'member',
            issuedAt: iso(issuedAt),
            expiresAt: iso(issuedAt + 15 * 60_000),
            ...overrides,
        });
    }

    /** The browser's whole join: options with the ticket, a new credential, then verify with the ticket again. */
    async function joinWith(token: string, credentialId = `credential-${String(ids)}`) {
        const options = await join.options({ ticket: token, rp: RP });
        if (options.kind !== 'options') return options;
        return join.complete({
            ticket: token,
            response: ceremonies.register(options.options, credentialId, RP),
            rp: RP,
        });
    }

    const owner = (): Member => {
        const found = runtime
            .controller()
            .inspect()
            .members.find((member) => member.role === 'owner' && member.status === 'active');
        if (found === undefined) throw new Error('the seed has no owner');
        return found;
    };

    function apiAs(memberId: string): EngineApiClient {
        return createEngineApiClient(
            runtime.core().transport({
                memberId: memberId as Member['id'],
                sessionId: 'session-test' as never,
                client: CLIENT,
                permissions: new Set(PERMISSIONS),
                stepUpFresh: true,
            }),
        );
    }

    async function approve(code: string, role: Member['role'] = 'member') {
        const [request] = runtime.controller().inspect().accessRequests;
        if (request === undefined) throw new Error('no pending request');
        return apiAs(owner().id).members.approveAccessRequest(request.id, { code, role }, SIGNAL);
    }

    async function revocation(dashboardUserId: string, revocationId: string, signer: Signer = memberSigner) {
        return signMemberRevocation(signer, {
            v: 1,
            engineId: ENGINE_ID,
            revocationId,
            dashboardUserId,
            issuedAt: iso(clock.nowMs()),
        });
    }

    return {
        clock,
        runtime,
        join,
        ticket,
        joinWith,
        approve,
        apiAs,
        owner,
        revocation,
        passkeys,
        sessions,
        ceremonies,
        logger,
        startGateway,
    };
}

const forger = async () => createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));

describe('join gateway: tickets', () => {
    it('turns a valid ticket and a new passkey into a pending request with a 6-digit code', async () => {
        const { join, ticket, joinWith, runtime } = await setup();
        const outcome = await joinWith(await ticket());
        expect(outcome.kind === 'waiting' && /^\d{6}$/.test(outcome.code)).toBe(true);
        const [request] = runtime.controller().inspect().accessRequests;
        expect(request).toMatchObject({ displayName: 'Dana Novak', email: 'dana@example.com', proposedRole: 'member' });
        expect(join.pendingRequests()).toBe(1);
    });

    it('refuses every ticket while no member key is pinned', async () => {
        const { join, ticket } = await setup({ pinned: false });
        expect(join.enabled()).toBe(false);
        expect(await join.options({ ticket: await ticket(), rp: RP })).toEqual({ kind: 'invalid' });
    });

    it.each([
        ['signed by another key', async (make: Awaited<ReturnType<typeof setup>>) => make.ticket({}, await forger())],
        ['for another engine', (make: Awaited<ReturnType<typeof setup>>) => make.ticket({ engineId: OTHER_ENGINE })],
        ['malformed', () => Promise.resolve('not.a-ticket')],
    ])('refuses a ticket %s as invalid', async (_label, make) => {
        const context = await setup();
        expect(await context.join.options({ ticket: await make(context), rp: RP })).toEqual({ kind: 'invalid' });
    });

    it('refuses an expired ticket and one issued in the future', async () => {
        const { join, ticket, clock } = await setup();
        const expired = await ticket();
        clock.advance(15 * 60_000);
        expect(await join.options({ ticket: expired, rp: RP })).toEqual({ kind: 'expired' });
        const later = clock.nowMs() + 10 * 60_000;
        const early = await ticket({ issuedAt: iso(later), expiresAt: iso(later + 60_000) });
        expect(await join.options({ ticket: early, rp: RP })).toEqual({ kind: 'expired' });
    });

    it('spends a ticket once: a replay is refused as used', async () => {
        const { join, ticket, joinWith } = await setup();
        const token = await ticket();
        expect((await joinWith(token)).kind).toBe('waiting');
        expect(await join.options({ ticket: token, rp: RP })).toEqual({ kind: 'used' });
    });

    it('lets only one of two browsers racing with the same ticket make a request', async () => {
        const { join, ticket, ceremonies, runtime } = await setup();
        const token = await ticket();
        const first = await join.options({ ticket: token, rp: RP });
        const second = await join.options({ ticket: token, rp: RP });
        if (first.kind !== 'options' || second.kind !== 'options') throw new Error('no options');
        const outcomes = await Promise.all([
            join.complete({ ticket: token, response: ceremonies.register(first.options, 'credential-a', RP), rp: RP }),
            join.complete({ ticket: token, response: ceremonies.register(second.options, 'credential-b', RP), rp: RP }),
        ]);
        expect(outcomes.map(({ kind }) => kind).sort()).toEqual(['used', 'waiting']);
        expect(runtime.controller().inspect().accessRequests).toHaveLength(1);
    });

    it('keeps a spent ticket spent across a restart when its store is durable', async () => {
        // The same store for both gateways stands in for the file the engine reads back (fs-spent-ticket-store).
        const durable = createInMemorySpentTickets();
        const context = await setup({ spentTickets: () => durable });
        const token = await context.ticket();
        expect((await context.joinWith(token)).kind).toBe('waiting');
        const restarted = context.startGateway();
        expect(await restarted.options({ ticket: token, rp: RP })).toEqual({ kind: 'used' });
        expect((await restarted.options({ ticket: await context.ticket(), rp: RP })).kind).toBe('options');
    });

    it('refuses a ticket as full when the store keeps its maximum', async () => {
        const full: SpentTicketStore = { has: () => Promise.resolve(false), spend: () => Promise.resolve('full') };
        const context = await setup({ spentTickets: () => full });
        expect(await context.joinWith(await context.ticket())).toEqual({ kind: 'full' });
        expect(context.runtime.controller().inspect().accessRequests).toEqual([]);
    });

    it('forgets spent tickets across a restart without a durable store, which is why engines must keep one', async () => {
        const context = await setup();
        const token = await context.ticket();
        expect((await context.joinWith(token)).kind).toBe('waiting');
        expect((await context.startGateway().options({ ticket: token, rp: RP })).kind).toBe('options');
    });

    it('refuses a passkey that does not verify and keeps the ticket usable', async () => {
        const { join, ticket } = await setup();
        const token = await ticket();
        const options = await join.options({ ticket: token, rp: RP });
        expect(options.kind).toBe('options');
        expect(await join.complete({ ticket: token, response: { fake: 'nonsense' }, rp: RP })).toEqual({
            kind: 'not-verified',
        });
        expect((await join.options({ ticket: token, rp: RP })).kind).toBe('options');
    });

    it(`stops at ${String(MAX_PENDING_ACCESS_REQUESTS)} pending requests, but lets a person replace their own`, async () => {
        const { join, ticket, joinWith, runtime } = await setup();
        for (let index = 0; index < MAX_PENDING_ACCESS_REQUESTS; index++) {
            expect((await joinWith(await ticket())).kind).toBe('waiting');
        }
        expect(await join.options({ ticket: await ticket(), rp: RP })).toEqual({ kind: 'full' });
        const again = await joinWith(await ticket({ dashboardUserId: 'user-1' }));
        expect(again.kind).toBe('waiting');
        expect(runtime.controller().inspect().accessRequests).toHaveLength(MAX_PENDING_ACCESS_REQUESTS);
    });
});

describe('join gateway: approval', () => {
    it('signs the person in once approved with the code, and acks the ticket approved', async () => {
        const { join, ticket, joinWith, approve, passkeys, runtime } = await setup();
        const token = await ticket({ dashboardUserId: 'user-dana' });
        const waiting = await joinWith(token, 'credential-dana');
        if (waiting.kind !== 'waiting') throw new Error(waiting.kind);
        expect(await join.status({ request: waiting.request, client: CLIENT })).toEqual({ kind: 'waiting' });

        const wrong = waiting.code === '000000' ? '000001' : '000000';
        expect((await approve(wrong)).kind).toBe('problem');
        expect((await approve(waiting.code)).kind).toBe('ok');

        const status = await join.status({ request: waiting.request, client: CLIENT });
        expect(status.kind).toBe('approved');
        const member = runtime
            .controller()
            .inspect()
            .members.find(({ dashboardUserId }) => dashboardUserId === 'user-dana');
        expect(member?.status).toBe('active');
        expect((await passkeys.list()).map(({ credentialId, memberId }) => [credentialId, memberId])).toEqual([
            ['credential-dana', member?.id],
        ]);
        expect(join.acks()).toEqual([{ id: 'ticket-000000000001', outcome: 'approved' }]);
        // The token signs in once; a second poll knows nothing.
        expect(await join.status({ request: waiting.request, client: CLIENT })).toEqual({ kind: 'unknown' });
        expect(await join.options({ ticket: await ticket({ dashboardUserId: 'user-dana' }), rp: RP })).toEqual({
            kind: 'already-member',
        });
    });

    it(`drops the request after ${String(MAX_ACCESS_CODE_ATTEMPTS)} wrong codes: the page says declined, the ticket stays spent`, async () => {
        const { join, ticket, joinWith, approve } = await setup();
        const token = await ticket({ dashboardUserId: 'user-max' });
        const waiting = await joinWith(token);
        if (waiting.kind !== 'waiting') throw new Error(waiting.kind);
        const wrong = waiting.code === '000000' ? '000001' : '000000';
        for (let attempt = 0; attempt < MAX_ACCESS_CODE_ATTEMPTS; attempt++) {
            const answer = await approve(wrong);
            expect(answer.kind === 'problem' && answer.problem.code).toBe('access-code-mismatch');
        }
        await expect(approve(waiting.code)).rejects.toThrow('no pending request');
        expect(await join.status({ request: waiting.request, client: CLIENT })).toEqual({ kind: 'declined' });
        expect(join.acks()).toEqual([{ id: 'ticket-000000000001', outcome: 'declined' }]);
        expect(await join.options({ ticket: token, rp: RP })).toEqual({ kind: 'used' });
        expect((await joinWith(await ticket({ dashboardUserId: 'user-max' }))).kind).toBe('waiting');
    });

    it('reports a declined request to the page and in an ack', async () => {
        const { join, ticket, joinWith, runtime, apiAs, owner } = await setup();
        const waiting = await joinWith(await ticket());
        if (waiting.kind !== 'waiting') throw new Error(waiting.kind);
        const [request] = runtime.controller().inspect().accessRequests;
        await apiAs(owner().id).members.declineAccessRequest(request?.id ?? ('' as never), SIGNAL);
        expect(await join.status({ request: waiting.request, client: CLIENT })).toEqual({ kind: 'declined' });
        expect(join.acks()).toEqual([{ id: 'ticket-000000000001', outcome: 'declined' }]);
        join.acked(['ticket-000000000001']);
        expect(join.acks()).toEqual([]);
    });

    it('acks a ticket removed when an engine admin removes the member it brought', async () => {
        const { join, ticket, joinWith, approve, apiAs, owner, runtime } = await setup();
        const waiting = await joinWith(await ticket({ dashboardUserId: 'user-eve' }));
        if (waiting.kind !== 'waiting') throw new Error(waiting.kind);
        await approve(waiting.code);
        await join.settle();
        join.acked(join.acks().map(({ id }) => id));
        const member = runtime
            .controller()
            .inspect()
            .members.find(({ dashboardUserId }) => dashboardUserId === 'user-eve');
        await apiAs(owner().id).members.remove(member?.id ?? ('' as never), SIGNAL);
        await join.settle();
        expect(join.acks()).toEqual([{ id: 'ticket-000000000001', outcome: 'removed' }]);
    });
});

describe('join gateway: revocations', () => {
    async function joined(context: Awaited<ReturnType<typeof setup>>, dashboardUserId: string, role?: Member['role']) {
        const waiting = await context.joinWith(await context.ticket({ dashboardUserId }));
        if (waiting.kind !== 'waiting') throw new Error(waiting.kind);
        await context.approve(waiting.code, role);
        await context.join.settle();
        context.join.acked(context.join.acks().map(({ id }) => id));
        const member = context.runtime
            .controller()
            .inspect()
            .members.find((candidate) => candidate.dashboardUserId === dashboardUserId);
        if (member === undefined) throw new Error('not approved');
        return member;
    }

    it('disables the member, writes audit and acks revoked; a resent one is acked the same', async () => {
        const context = await setup();
        const member = await joined(context, 'user-fay');
        const token = await context.revocation('user-fay', 'revocation-0000000001');
        await context.join.applyRevocations([token]);
        const after = context.runtime.controller().inspect();
        expect(after.members.find(({ id }) => id === member.id)?.status).toBe('disabled');
        expect(after.passkeys.some(({ memberId }) => memberId === member.id)).toBe(false);
        expect(context.join.acks()).toEqual([{ id: 'revocation-0000000001', outcome: 'revoked' }]);
        context.join.acked(['revocation-0000000001']);
        await context.join.applyRevocations([token]);
        expect(context.join.acks()).toEqual([{ id: 'revocation-0000000001', outcome: 'revoked' }]);
        // Removed by the organization: the ticket is not reported as removed on the engine as well.
        await context.join.settle();
        expect(context.join.acks()).toHaveLength(1);
    });

    it('ignores a forged revocation and one for another engine, acking neither', async () => {
        const context = await setup();
        await joined(context, 'user-gus');
        const forged = await context.revocation('user-gus', 'revocation-0000000002', await forger());
        const misdirected = await signMemberRevocation(await forger(), {
            v: 1,
            engineId: OTHER_ENGINE,
            revocationId: 'revocation-0000000003',
            dashboardUserId: 'user-gus',
            issuedAt: iso(NOW),
        });
        await context.join.applyRevocations([forged, misdirected, 'garbage']);
        expect(context.join.acks()).toEqual([]);
        expect(
            context.runtime
                .controller()
                .inspect()
                .members.find(({ dashboardUserId }) => dashboardUserId === 'user-gus')?.status,
        ).toBe('active');
    });

    it('refuses to revoke the last owner and acks not-found for nobody', async () => {
        const context = await setup();
        const original = context.owner();
        const member = await joined(context, 'user-hal', 'owner');
        const demoted = await context.apiAs(member.id).members.update(original.id, { role: 'admin' }, SIGNAL);
        expect(demoted.kind).toBe('ok');
        await context.join.applyRevocations([
            await context.revocation('user-hal', 'revocation-0000000004'),
            await context.revocation('user-nobody', 'revocation-0000000005'),
        ]);
        expect(context.join.acks()).toEqual([
            { id: 'revocation-0000000004', outcome: 'refused-owner' },
            { id: 'revocation-0000000005', outcome: 'not-found' },
        ]);
    });

    it('ignores every revocation while no member key is pinned', async () => {
        const context = await setup({ pinned: false });
        context.runtime.controller().addMember({
            id: 'member-dashboard',
            displayName: 'Joined earlier',
            role: 'member',
            status: 'active',
            createdAt: iso(NOW),
            lastSeenAt: null,
            dashboardUserId: 'user-jan',
        });
        await context.join.applyRevocations([await context.revocation('user-jan', 'revocation-0000000007')]);
        expect(context.join.acks()).toEqual([]);
        expect(
            context.runtime
                .controller()
                .inspect()
                .members.find(({ id }) => id === 'member-dashboard')?.status,
        ).toBe('active');
    });

    it('never applies a resent revocation to the same person once they were approved again', async () => {
        const context = await setup();
        await joined(context, 'user-kim');
        const token = await context.revocation('user-kim', 'revocation-0000000008');
        await context.join.applyRevocations([token]);
        await joined(context, 'user-kim');
        await context.join.applyRevocations([token]);
        expect(context.join.acks()).toEqual([{ id: 'revocation-0000000008', outcome: 'revoked' }]);
        const kim = context.runtime
            .controller()
            .inspect()
            .members.filter(({ dashboardUserId }) => dashboardUserId === 'user-kim');
        expect(kim.map(({ status }) => status)).toEqual(['disabled', 'active']);
    });

    it('never logs a ticket, a code or a revocation', async () => {
        const context = await setup();
        const token = await context.ticket({ dashboardUserId: 'user-lea' });
        await context.join.options({ ticket: 'forged.ticket', rp: RP });
        const waiting = await context.joinWith(token);
        if (waiting.kind !== 'waiting') throw new Error(waiting.kind);
        await context.approve(waiting.code);
        await context.join.settle();
        const revocation = await context.revocation('user-lea', 'revocation-0000000009');
        await context.join.applyRevocations([
            revocation,
            await context.revocation('user-lea', 'x'.repeat(16), await forger()),
        ]);
        const logged = context.logger.text();
        expect(logged).toContain('member-revocation');
        for (const secret of [token, waiting.code, waiting.request, 'ticket-000000000001', revocation]) {
            expect(logged).not.toContain(secret);
        }
    });

    it('acks not-found and applies nothing for a revocation issued before the person joined again', async () => {
        const context = await setup();
        const issuedBeforeRejoin = await context.revocation('user-kim', 'revocation-0000000011');
        context.clock.advance(MEMBER_REVOCATION_MAX_SKEW_MS + 1_000);
        await joined(context, 'user-kim');
        await context.join.applyRevocations([issuedBeforeRejoin]);
        expect(context.join.acks()).toEqual([{ id: 'revocation-0000000011', outcome: 'not-found' }]);
        const kim = context.runtime
            .controller()
            .inspect()
            .members.filter(({ dashboardUserId }) => dashboardUserId === 'user-kim');
        expect(kim.map(({ status }) => status)).toEqual(['active']);
        // Still theirs to lose: a removal after they joined is applied, and the ticket still acks a later removal.
        await context.join.applyRevocations([await context.revocation('user-kim', 'revocation-0000000012')]);
        expect(context.join.acks().at(-1)).toEqual({ id: 'revocation-0000000012', outcome: 'revoked' });
    });

    it('leaves a pending request made after the revocation was issued', async () => {
        const context = await setup();
        const old = await context.revocation('user-liv', 'revocation-0000000013');
        context.clock.advance(10 * 60_000);
        const waiting = await context.joinWith(await context.ticket({ dashboardUserId: 'user-liv' }));
        if (waiting.kind !== 'waiting') throw new Error(waiting.kind);
        await context.join.applyRevocations([old]);
        expect(context.join.acks()).toEqual([{ id: 'revocation-0000000013', outcome: 'not-found' }]);
        expect(context.runtime.controller().inspect().accessRequests).toHaveLength(1);
        expect(await context.join.status({ request: waiting.request, client: CLIENT })).toEqual({ kind: 'waiting' });
    });

    it('applies a revocation issued within the clock skew before the join', async () => {
        const context = await setup();
        const close = await context.revocation('user-mia', 'revocation-0000000014');
        context.clock.advance(MEMBER_REVOCATION_MAX_SKEW_MS - 1_000);
        await joined(context, 'user-mia');
        await context.join.applyRevocations([close]);
        expect(context.join.acks()).toEqual([{ id: 'revocation-0000000014', outcome: 'revoked' }]);
    });

    it('refuses when the owner switched dashboard removals off', async () => {
        const context = await setup();
        await joined(context, 'user-ida');
        await context.apiAs(context.owner().id).settings.setDashboardRemovals({ enabled: false }, SIGNAL);
        await context.join.applyRevocations([await context.revocation('user-ida', 'revocation-0000000006')]);
        expect(context.join.acks()).toEqual([{ id: 'revocation-0000000006', outcome: 'refused-disabled' }]);
    });

    it('still acks the ticket removed when an engine admin removes someone whose revocation it refused', async () => {
        const context = await setup();
        const member = await joined(context, 'user-ivo');
        const owner = context.apiAs(context.owner().id);
        await owner.settings.setDashboardRemovals({ enabled: false }, SIGNAL);
        await context.join.applyRevocations([await context.revocation('user-ivo', 'revocation-0000000010')]);
        context.join.acked(['revocation-0000000010']);
        await owner.members.remove(member.id, SIGNAL);
        await context.join.settle();
        expect(context.join.acks()).toEqual([{ id: 'ticket-000000000001', outcome: 'removed' }]);
    });
});
