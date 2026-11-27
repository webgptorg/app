import { heartbeatPath, LinkCode, REGISTER_PATH } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { LinkCodeView, SessionView, TeamView } from '../../src/shared/api/routes';
import { createAuthHarness, type AuthHarness, type TestBrowser } from '../../src/testing/auth-harness';
import { lastEmail, registerWith, requestOptions, signUp, uniqueEmail } from '../../src/testing/auth-flows';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryBillingStore } from '../../src/testing/memory-billing-store';
import { createMemoryRegistrationStores } from '../../src/testing/memory-registration-store';
import { createMemoryTeamStore } from '../../src/testing/memory-team-store';
import { createTestEngine, type TestEngine } from '../../src/testing/test-engine';
import { signedHeartbeat, signedHeartbeatV2 } from '../../src/testing/test-heartbeat';
import type { UsageStore } from '../../src/domain/usage/usage-store';

function harnessOn(usageStore?: Pick<UsageStore, 'insertEvents'>): AuthHarness {
    const store = createMemoryAuthStore();
    const registration = createMemoryRegistrationStores({ orgExists: (orgId) => store.state.orgs.has(orgId) });
    return createAuthHarness({
        store,
        billingStore: createMemoryBillingStore({ org: (orgId) => store.state.orgs.get(orgId) }),
        registration,
        teams: createMemoryTeamStore({ auth: store.state, registration: registration.state }),
        ...(usageStore === undefined ? {} : { usageStore }),
    });
}

let ips = 0;

async function person(harness: AuthHarness, email = uniqueEmail()) {
    ips++;
    const browser = harness.browser({ ip: `203.0.113.${String(ips)}` });
    await signUp(harness, browser, email);
    const session = (await browser.request('GET', '/api/session')).body as SessionView;
    return { browser, email, userId: session.user.id, orgId: session.activeOrg.id };
}

async function subscribed(harness: AuthHarness) {
    const owner = await person(harness);
    expect((await owner.browser.request('POST', '/api/billing/checkout', { planId: 'starter' })).status).toBe(200);
    return owner;
}

async function stepUp(browser: TestBrowser): Promise<void> {
    const options = requestOptions(await browser.request('POST', '/api/auth/step-up/options'));
    const response = await browser.authenticator.assert(options);
    expect((await browser.request('POST', '/api/auth/step-up/verify', { response })).status).toBe(200);
}

async function link(harness: AuthHarness, browser: TestBrowser, path: string): Promise<TestEngine> {
    const issued = await browser.request('POST', path);
    expect(issued.status).toBe(200);
    const engine = await createTestEngine();
    const request = await engine.register(LinkCode.parse((issued.body as LinkCodeView).linkCode));
    expect((await harness.browser({ ip: '198.51.100.7' }).request('POST', REGISTER_PATH, request)).status).toBe(200);
    return engine;
}

function recorded(harness: AuthHarness) {
    return harness.usage.state.events.map((row) => ({
        event: row.event,
        orgId: row.orgId,
        userId: row.userId,
        engineId: row.engineId,
        props: JSON.parse(row.props) as unknown,
    }));
}

describe('usage events over HTTP (ADR 0022)', () => {
    it('follows an account from sign-up through a linked engine to its setup and removal', async () => {
        const harness = harnessOn();
        const owner = await subscribed(harness);
        const subject = { orgId: owner.orgId, userId: owner.userId };
        expect(recorded(harness)).toEqual([
            { event: 'account.signed_up', ...subject, engineId: null, props: { via: 'signup' } },
            { event: 'org.created', ...subject, engineId: null, props: { kind: 'personal' } },
        ]);

        const engine = await link(harness, owner.browser, '/api/engines/link-codes');
        let seq = 0;
        for (const setup of ['pending', 'pending', 'done'] as const) {
            harness.clock.advance(60_000);
            const beat = await signedHeartbeat(engine, ++seq, harness.clock.nowMs(), { setup });
            expect((await harness.post(heartbeatPath(engine.engineId), beat.body, beat.headers)).status).toBe(204);
        }
        await stepUp(owner.browser);
        expect((await owner.browser.request('POST', `/api/engines/${engine.engineId}/revoke`)).status).toBe(200);

        const engineEvents = { orgId: owner.orgId, engineId: engine.engineId };
        expect(recorded(harness).slice(2)).toEqual([
            { event: 'engine.created', ...subject, engineId: null, props: { forTeam: false } },
            { event: 'engine.linked', ...engineEvents, userId: null, props: { mode: 'tunnel', relinked: false } },
            { event: 'engine.first_heartbeat', ...engineEvents, userId: null, props: { setup: 'pending' } },
            { event: 'engine.setup_completed', ...engineEvents, userId: null, props: {} },
            { event: 'engine.removed', ...subject, engineId: engine.engineId, props: { via: 'revoked' } },
        ]);
    });

    it('records invitations sent and accepted, access asked for and answered, and a team’s engine removed', async () => {
        const harness = harnessOn();
        const owner = await subscribed(harness);
        const team = (
            (await owner.browser.request('POST', '/api/teams', { name: 'Client A' })).body as { team: TeamView }
        ).team;
        const engine = await link(harness, owner.browser, `/api/teams/${team.teamId}/link-codes`);

        const newcomer = uniqueEmail('newcomer');
        const regular = uniqueEmail('regular');
        expect(
            (
                await owner.browser.request('POST', '/api/invites', {
                    emails: [newcomer, regular, owner.email],
                    role: 'member',
                    teamIds: [team.teamId],
                })
            ).status,
        ).toBe(200);
        const tokenOf = (to: string) => {
            const message = lastEmail(harness, to);
            return message.template === 'team-invite' ? new URL(message.link).hash.slice(1) : '';
        };

        // Read before the invitees' own emails arrive: their sign-up link would be the last one.
        const newcomerToken = tokenOf(newcomer);
        const regularToken = tokenOf(regular);
        const joiner = harness.browser({ ip: '203.0.113.200' });
        const { verify } = await registerWith(joiner, '/api/invites/join/options', '/api/invites/join/verify', {
            token: newcomerToken,
        });
        expect(verify.status).toBe(200);
        const joinerId = ((await joiner.request('GET', '/api/session')).body as SessionView).user.id;

        const existing = await person(harness, regular);
        expect((await existing.browser.request('POST', '/api/invites/accept', { token: regularToken })).status).toBe(
            200,
        );
        expect((await existing.browser.request('POST', '/api/session/active-org', { orgId: owner.orgId })).status).toBe(
            200,
        );

        const opened = await existing.browser.request('POST', `/api/teams/${team.teamId}/access-ticket`);
        expect(opened.status).toBe(200);

        const events = recorded(harness);
        const inOrg = events.filter((row) => row.orgId === owner.orgId);
        expect(inOrg.filter((row) => row.event === 'engine.created')).toEqual([
            {
                event: 'engine.created',
                orgId: owner.orgId,
                userId: owner.userId,
                engineId: null,
                props: { forTeam: true },
            },
        ]);
        // The owner is in the organization already: added to the team, not invited.
        expect(inOrg.filter((row) => row.event === 'invite.sent')).toEqual(
            Array.from({ length: 2 }, () => ({
                event: 'invite.sent',
                orgId: owner.orgId,
                userId: owner.userId,
                engineId: null,
                props: { role: 'member', teams: 1 },
            })),
        );
        expect(
            inOrg.filter(
                (row) =>
                    row.userId !== owner.userId &&
                    (row.event === 'invite.accepted' || row.event === 'account.signed_up'),
            ),
        ).toEqual([
            {
                event: 'account.signed_up',
                orgId: owner.orgId,
                userId: joinerId,
                engineId: null,
                props: { via: 'invite' },
            },
            {
                event: 'invite.accepted',
                orgId: owner.orgId,
                userId: joinerId,
                engineId: null,
                props: { as: 'new-account' },
            },
            {
                event: 'invite.accepted',
                orgId: owner.orgId,
                userId: existing.userId,
                engineId: null,
                props: { as: 'existing-account' },
            },
        ]);
        expect(inOrg.filter((row) => row.event === 'access.requested')).toEqual([
            {
                event: 'access.requested',
                orgId: owner.orgId,
                userId: existing.userId,
                engineId: engine.engineId,
                props: {},
            },
        ]);

        await answerTheOnlyTicket(harness, engine, 'declined');
        expect((await existing.browser.request('POST', `/api/teams/${team.teamId}/access-ticket`)).status).toBe(200);
        await answerTheOnlyTicket(harness, engine, 'approved');
        expect(
            recorded(harness).filter((row) => row.event.startsWith('access.') && row.event !== 'access.requested'),
        ).toEqual([
            {
                event: 'access.declined',
                orgId: owner.orgId,
                userId: existing.userId,
                engineId: engine.engineId,
                props: {},
            },
            {
                event: 'access.approved',
                orgId: owner.orgId,
                userId: existing.userId,
                engineId: engine.engineId,
                props: {},
            },
        ]);

        await stepUp(owner.browser);
        expect((await owner.browser.request('POST', `/api/teams/${team.teamId}/delete`)).status).toBe(204);
        expect(recorded(harness).at(-1)).toEqual({
            event: 'engine.removed',
            orgId: owner.orgId,
            userId: owner.userId,
            engineId: engine.engineId,
            props: { via: 'team-deleted' },
        });
    });

    it('answers every request as usual when no event can be written', async () => {
        const harness = harnessOn({ insertEvents: () => Promise.reject(new Error('D1 unavailable')) });
        const owner = await subscribed(harness);
        const engine = await link(harness, owner.browser, '/api/engines/link-codes');
        const beat = await signedHeartbeat(engine, 1, harness.clock.nowMs(), { setup: 'pending' });
        expect((await harness.post(heartbeatPath(engine.engineId), beat.body, beat.headers)).status).toBe(204);
        expect(harness.usage.state.events).toEqual([]);
        const failures = harness.logger.entries.filter((entry) => entry.event === 'usage.record-failed');
        expect(failures.length).toBeGreaterThanOrEqual(4);
        for (const failure of failures) {
            expect(Object.keys(failure.fields).sort()).toEqual(['error', 'events']);
        }
    });
});

let v2Seq = 10;

/** The engine answers the one request it holds, acking the ticket the dashboard signed, in a v2 heartbeat. */
async function answerTheOnlyTicket(
    harness: AuthHarness,
    engine: TestEngine,
    outcome: 'approved' | 'declined',
): Promise<void> {
    const tickets = await harness.deps.teams.ticketsAwaitingNotice(engine.engineId, 0);
    expect(tickets).toHaveLength(1);
    const [ticket] = tickets;
    harness.clock.advance(60_000);
    const beat = await signedHeartbeatV2(engine, ++v2Seq, harness.clock.nowMs(), {
        acks: [{ id: ticket?.ticketId ?? '', outcome }],
    });
    expect((await harness.post(heartbeatPath(engine.engineId), beat.body, beat.headers)).status).toBe(200);
}
