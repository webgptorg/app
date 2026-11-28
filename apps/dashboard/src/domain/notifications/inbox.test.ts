import { describe, expect, it } from 'vitest';

import { createMemoryAuthStore } from '../../testing/memory-auth-store';
import { createMemoryNotificationStore } from '../../testing/memory-notification-store';
import { createMemoryRegistrationStores } from '../../testing/memory-registration-store';
import { createMemoryTeamStore } from '../../testing/memory-team-store';
import { createNotificationScenario } from '../../testing/test-notifications';
import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { teamNameSchema } from '../../shared/team-name';
import { newNotificationId, newOrgId } from '../ids';
import type { OpenNotificationRecord } from './notification-store';
import { readInbox, readPreferences, recipientRoleOf, setPreference, unsubscribe } from './inbox';

describe('the bell', () => {
    it('lists the actor’s open rows of projects they still see, active ones only, and other orgs with unseen rows', async () => {
        const { orgId, member } = await createNotificationScenario();
        const auth = createMemoryAuthStore();
        const registration = createMemoryRegistrationStores({ orgExists: () => true });
        const teams = createMemoryTeamStore({ auth: auth.state, registration: registration.state });
        const store = createMemoryNotificationStore();
        const random = { bytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) };
        const seen = await createTestEngine();
        const hidden = await createTestEngine();
        const revoked = await createTestEngine();
        registration.state.engines.set(seen.engineId, engineRecord(seen, orgId));
        registration.state.engines.set(hidden.engineId, engineRecord(hidden, orgId));
        registration.state.engines.set(
            revoked.engineId,
            engineRecord(revoked, orgId, { status: 'suspended', statusReason: 'x' }),
        );
        const teamId = 'teamteamteamteamteamteamte' as never;
        teams.state.teams.set(teamId, {
            id: teamId,
            orgId,
            name: teamNameSchema.parse('Client A'),
            createdAt: 0,
            deletedAt: null,
        });
        teams.state.engineTeams.set(seen.engineId, teamId);
        teams.state.members.push({ teamId, userId: member.userId, createdAt: 0, access: 'approved' });
        const row = (overrides: Partial<OpenNotificationRecord>): OpenNotificationRecord => ({
            id: newNotificationId(random),
            orgId,
            userId: member.userId,
            engineId: null,
            kind: 'people-change',
            variant: 'role',
            count: 1,
            openedAt: 1,
            updatedAt: 1,
            seenAt: null,
            emailedAt: null,
            dueAt: null,
            closedAt: null,
            ...overrides,
        });
        const otherOrg = newOrgId(random);
        const orgRow = row({ updatedAt: 5 });
        const seenRow = row({ engineId: seen.engineId, kind: 'agent-waiting', variant: null, seenAt: 3, updatedAt: 4 });
        await store.write(
            [
                orgRow,
                seenRow,
                row({ engineId: hidden.engineId, kind: 'agent-waiting', variant: null }),
                row({ engineId: revoked.engineId, kind: 'agent-waiting', variant: null }),
                row({ orgId: otherOrg }),
            ].map((r) => ({ op: 'insert', row: r }) as const),
        );
        const inbox = await readInbox(
            { store, engines: registration.engines, teams, clock: { nowMs: () => 0 } },
            { orgId, userId: member.userId, orgRole: 'member' },
        );
        expect(inbox).toEqual({
            items: [
                {
                    id: orgRow.id,
                    kind: 'people-change',
                    variant: 'role',
                    count: 1,
                    openedAt: 1,
                    updatedAt: 5,
                    seen: false,
                    project: null,
                },
                {
                    id: seenRow.id,
                    kind: 'agent-waiting',
                    variant: null,
                    count: 1,
                    openedAt: 1,
                    updatedAt: 4,
                    seen: true,
                    project: {
                        engineId: seen.engineId,
                        label: 'Client A',
                        hostname: engineRecord(seen, orgId).hostname,
                    },
                },
            ],
            otherOrgsWithUnseen: [otherOrg],
        });
        // An owner sees every project, also one whose team is gone, which then goes by its short ID.
        const bare = 'bareteambareteambareteamba' as never;
        teams.state.teams.set(bare, {
            id: bare,
            orgId,
            name: teamNameSchema.parse('Empty'),
            createdAt: 0,
            deletedAt: null,
        });
        const asOwner = await readInbox(
            { store, engines: registration.engines, teams, clock: { nowMs: () => 0 } },
            { orgId, userId: member.userId, orgRole: 'owner' },
        );
        expect(asOwner.items.map((item) => item.project?.label ?? null)).toEqual([
            null,
            'Client A',
            `${hidden.engineId.slice(0, 8)}…`,
        ]);
    });
});

describe('preferences', () => {
    it('reads defaults by role, stores only overrides, and unsubscribing turns email off but leaves off alone', async () => {
        const { orgId, member } = await createNotificationScenario();
        const store = createMemoryNotificationStore();
        const actor = { orgId, userId: member.userId, orgRole: 'member' as const };
        const of = async (kind: string) => (await readPreferences({ store }, actor)).find((p) => p.kind === kind);
        expect(await of('update-waiting')).toEqual({ kind: 'update-waiting', channel: 'off', defaultChannel: 'off' });
        await setPreference({ store }, actor, 'update-waiting', 'in-app');
        expect(await store.overrides(orgId, member.userId)).toEqual(new Map([['update-waiting', 'in-app']]));
        await setPreference({ store }, actor, 'update-waiting', 'off');
        expect(await store.overrides(orgId, member.userId)).toEqual(new Map());
        await setPreference({ store }, actor, 'task-failed', 'off');
        await unsubscribe({ store }, { userId: member.userId, orgId, kinds: ['task-failed', 'agent-waiting'] });
        expect(await store.overrides(orgId, member.userId)).toEqual(
            new Map([
                ['task-failed', 'off'],
                ['agent-waiting', 'in-app'],
            ]),
        );
        expect(['owner', 'admin', 'member'].map((role) => recipientRoleOf(role as never))).toEqual([
            'org-owner',
            'org-admin',
            'member',
        ]);
    });
});
