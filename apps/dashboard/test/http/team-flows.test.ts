import { describe, expect, it } from 'vitest';

import type { TeamStore } from '../../src/domain/teams/team-store';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { lastEmail, problemCode, registerWith, signUp, uniqueEmail } from '../../src/testing/auth-flows';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryBillingStore } from '../../src/testing/memory-billing-store';
import { createMemoryRegistrationStores } from '../../src/testing/memory-registration-store';
import { createMemoryTeamStore } from '../../src/testing/memory-team-store';
import { describeTeamFlows } from '../../src/testing/team-flow-suite';

describeTeamFlows('teams on the in-memory stores', () => {
    const store = createMemoryAuthStore();
    const registration = createMemoryRegistrationStores({ orgExists: (orgId) => store.state.orgs.has(orgId) });
    const teams = createMemoryTeamStore({ auth: store.state, registration: registration.state });
    return {
        harness: createAuthHarness({
            store,
            billingStore: createMemoryBillingStore({ org: (orgId) => store.state.orgs.get(orgId) }),
            registration,
            teams,
        }),
        revokedOn: (userId) =>
            Promise.resolve(teams.state.revocations.filter((row) => row.userId === userId).map((row) => row.engineId)),
    };
});

describe('an invitation used up between its preview and its acceptance', () => {
    it('answers invite-invalid and writes nothing', async () => {
        const store = createMemoryAuthStore();
        const registration = createMemoryRegistrationStores({ orgExists: (orgId) => store.state.orgs.has(orgId) });
        const memory = createMemoryTeamStore({ auth: store.state, registration: registration.state });
        // Another tab spent the invitation a moment earlier: the preview still saw it pending.
        const teams: TeamStore = {
            ...memory,
            acceptInvite: () => Promise.resolve({ kind: 'invalid' }),
            acceptInviteAsNewUser: () => Promise.resolve({ kind: 'invalid' }),
        };
        const harness = createAuthHarness({ store, registration, teams });
        const inviter = harness.browser({ ip: '203.0.113.90' });
        await signUp(harness, inviter);
        const invited = uniqueEmail('raced');
        expect(
            (await inviter.request('POST', '/api/invites', { emails: [invited], role: 'member', teamIds: [] })).status,
        ).toBe(200);
        const message = lastEmail(harness, invited);
        const token = message.template === 'team-invite' ? new URL(message.link).hash.slice(1) : '';

        const joiner = harness.browser({ ip: '203.0.113.91' });
        const { verify } = await registerWith(joiner, '/api/invites/join/options', '/api/invites/join/verify', {
            token,
        });
        expect([verify.status, problemCode(verify)]).toEqual([404, 'invite-invalid']);
        expect(await store.accounts.findUserByEmail(invited)).toBeNull();

        const existing = harness.browser({ ip: '203.0.113.92' });
        await signUp(harness, existing, invited);
        const accepted = await existing.request('POST', '/api/invites/accept', { token });
        expect([accepted.status, problemCode(accepted)]).toEqual([404, 'invite-invalid']);

        const { offers } = (await existing.request('GET', '/api/invites/offers')).body as {
            offers: { inviteId: string }[];
        };
        const offered = await existing.request('POST', `/api/invites/offers/${offers[0]?.inviteId ?? ''}/accept`);
        expect([offered.status, problemCode(offered)]).toEqual([404, 'invite-invalid']);
    });
});

describe('an invitation to an address the account never verified', () => {
    it('is neither offered nor accepted without its token', async () => {
        const store = createMemoryAuthStore();
        const registration = createMemoryRegistrationStores({ orgExists: (orgId) => store.state.orgs.has(orgId) });
        const teams = createMemoryTeamStore({ auth: store.state, registration: registration.state });
        const harness = createAuthHarness({ store, registration, teams });
        const inviter = harness.browser({ ip: '203.0.113.93' });
        await signUp(harness, inviter);
        const invited = uniqueEmail('unverified');
        await inviter.request('POST', '/api/invites', { emails: [invited], role: 'member', teamIds: [] });
        const [pending] = teams.state.invites;

        const browser = harness.browser({ ip: '203.0.113.94' });
        await signUp(harness, browser, invited);
        const user = await store.accounts.findUserByEmail(invited);
        if (user === null || pending === undefined) {
            throw new Error('expected the account and the invitation');
        }
        // No path makes such an account today; the offer must still not take the address on trust if one appears.
        store.state.users.set(user.id, { ...user, emailVerifiedAt: null });
        expect((await browser.request('GET', '/api/invites/offers')).body).toEqual({ offers: [] });
        const accepted = await browser.request('POST', `/api/invites/offers/${pending.id}/accept`);
        expect([accepted.status, problemCode(accepted)]).toEqual([404, 'invite-invalid']);
    });
});
