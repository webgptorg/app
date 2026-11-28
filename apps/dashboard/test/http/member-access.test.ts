import { describe, expect, it } from 'vitest';

import { cryptoRandom } from '../../src/adapters/crypto-random';
import { createFakeClock } from '../../src/adapters/fake-clock';
import { createMemoryLogger } from '../../src/adapters/memory-logger';
import { testAccount } from '../../src/testing/auth-store-contract';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryRegistrationStores } from '../../src/testing/memory-registration-store';
import { createMemoryTeamStore } from '../../src/testing/memory-team-store';
import { createTestEngine, engineRecord } from '../../src/testing/test-engine';
import { teamNameSchema } from '../../src/shared/team-name';
import { newOrgAuditEntryId, newTeamId } from '../../src/domain/ids';
import { handleHeartbeatV2, issueAccessTicket } from '../../src/domain/teams/member-access';
import { memberKeySource, type MemberKeySource } from '../../src/domain/teams/member-key';

const NOW = 1_800_000_000_000;

/** A team with a linked engine and its owner in it, over the in-memory stores. */
async function setup(memberKey: MemberKeySource, status: 'active' | 'suspended' = 'active') {
    const auth = createMemoryAuthStore();
    const registration = createMemoryRegistrationStores({ orgExists: () => true });
    const teams = createMemoryTeamStore({ auth: auth.state, registration: registration.state });
    const account = testAccount();
    await auth.accounts.createAccount(account);
    const engine = await createTestEngine();
    registration.state.engines.set(engine.engineId, engineRecord(engine, account.orgId, { status }));
    const teamId = newTeamId(cryptoRandom);
    await teams.create(
        { id: teamId, orgId: account.orgId, name: teamNameSchema.parse('Team'), createdAt: NOW },
        account.userId,
        { id: newOrgAuditEntryId(cryptoRandom), actorUserId: account.userId, at: NOW },
    );
    teams.state.engineTeams.set(engine.engineId, teamId);
    const deps = {
        teams,
        engines: registration.engines,
        memberKey,
        clock: createFakeClock(NOW),
        random: cryptoRandom,
        logger: createMemoryLogger(),
        teamLink: (id: string) => `https://app.ptbk.test/teams/${id}`,
    };
    const actor = {
        orgId: account.orgId,
        userId: account.userId,
        orgRole: 'owner' as const,
        email: account.user.email,
    };
    return { deps, actor, teamId, engine, teams, registration };
}

const noKey: MemberKeySource = () => Promise.resolve(null);

describe('member access without a member key', () => {
    it('issues no ticket and holds revocations back', async () => {
        const { deps, actor, teamId, engine, teams } = await setup(noKey);
        expect(await issueAccessTicket(deps, actor, teamId)).toEqual({ kind: 'unavailable' });
        teams.state.revocations.push({
            id: 'revocation-00000001',
            engineId: engine.engineId,
            userId: actor.userId,
            createdAt: NOW,
        });
        const result = await handleHeartbeatV2(deps, engine.engineId, {
            v: 2,
            engineId: engine.engineId,
            seq: 1,
            ts: new Date(NOW).toISOString(),
            version: '1.0.0',
            uptimeS: 1,
            diskPct: 10,
            ramPct: 10,
            cpuLoad: 'low',
            update: 'none',
            agents: 0,
            members: 1,
            accessRequests: 0,
            // An ack for a ticket this dashboard never issued changes nothing and mails nobody.
            acks: [{ id: 'never-issued-ticket-1', outcome: 'approved' }],
        } as never);
        expect(result.reply).toEqual({ v: 1, revocations: [] });
        expect(teams.state.revocations[0]?.ackedAt).toBeUndefined();
        const sent: unknown[] = [];
        await result.deliver({
            send: (message) => {
                sent.push(message);
                return Promise.resolve();
            },
            notifications: { notify: () => Promise.reject(new Error('not reached')) },
            signal: new AbortController().signal,
        });
        expect(sent).toEqual([]);
    });

    it('loads no key from no seed', async () => {
        expect(await memberKeySource(null)()).toBeNull();
    });
});

describe('issueAccessTicket', () => {
    it('refuses a suspended engine', async () => {
        const { deps, actor, teamId } = await setup(noKey, 'suspended');
        expect(await issueAccessTicket(deps, actor, teamId)).toEqual({ kind: 'not-found' });
    });
});

describe('access emails', () => {
    it('sends no “you’re in” email for an engine the dashboard no longer finds in the organization', async () => {
        const { deps, actor, teamId, engine, teams, registration } = await setup(
            memberKeySource(new Uint8Array(32).fill(7)),
        );
        const ticketId = 'ticket-00000000000001';
        await teams.recordTicket({
            id: ticketId,
            teamId,
            engineId: engine.engineId,
            userId: actor.userId,
            issuedAt: NOW,
            expiresAt: NOW + 60_000,
        });
        registration.state.engines.delete(engine.engineId);
        type Heartbeat = Parameters<typeof handleHeartbeatV2>[2];
        const sent: unknown[] = [];
        const send = {
            send: (message: unknown) => {
                sent.push(message);
                return Promise.resolve();
            },
            notifications: { notify: () => Promise.resolve() },
            signal: new AbortController().signal,
        };
        const waiting = { accessRequests: 1, acks: [] } as unknown as Heartbeat;
        await (await handleHeartbeatV2(deps, engine.engineId, waiting)).deliver(send);
        const approved = { accessRequests: 0, acks: [{ id: ticketId, outcome: 'approved' }] } as unknown as Heartbeat;
        await (await handleHeartbeatV2(deps, engine.engineId, approved)).deliver(send);
        expect(sent).toEqual([]);
    });
});
