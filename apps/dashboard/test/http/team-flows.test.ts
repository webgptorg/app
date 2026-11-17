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
    });
});
