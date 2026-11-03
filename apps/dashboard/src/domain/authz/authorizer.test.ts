import { describe, expect, it } from 'vitest';

import { orgIdSchema, userIdSchema } from '../ids';
import {
    createAuthorizer,
    orgPermissions,
    RECOVERY_COOLDOWN_MS,
    STEP_UP_WINDOW_MS,
    type Actor,
    type PolicyTable,
} from './authorizer';
import type { OrgRole } from '../roles';
import { DASHBOARD_POLICY, type DashboardAction } from './policy';

const ORG_A = orgIdSchema.parse('aaaaaaaaaaaaaaaaaaaaaaaaaa');
const ORG_B = orgIdSchema.parse('bbbbbbbbbbbbbbbbbbbbbbbbbb');
const USER = userIdSchema.parse('uuuuuuuuuuuuuuuuuuuuuuuuuu');
const OTHER_USER = userIdSchema.parse('vvvvvvvvvvvvvvvvvvvvvvvvvv');
const owner: Actor = {
    userId: USER,
    orgId: ORG_A,
    orgRole: 'owner',
    platformRole: 'none',
    recoveredAt: null,
    steppedUpAt: null,
};

const FLAGS = { sensitive: false, requiresStepUp: false } as const;
const testPolicy = {
    'org.read': { scope: 'org', orgRoles: ['owner'], ...FLAGS },
    'org.nobody': { scope: 'org', orgRoles: [], ...FLAGS },
    'engine.remove': { scope: 'org', orgRoles: ['owner'], sensitive: true, requiresStepUp: false },
    'passkey.manage': { scope: 'self', ...FLAGS },
    'platform.engines.suspend': { scope: 'platform', sensitive: false, requiresStepUp: true },
} as const satisfies PolicyTable<string>;

const HOUR = 60 * 60 * 1000;
const RECOVERED_AT = 1_000 * HOUR;

describe('Authorizer', () => {
    let now = RECOVERED_AT;
    const clock = { nowMs: () => now };
    const authorizer = createAuthorizer({ clock, policy: testPolicy });
    const orgA = { kind: 'org', orgId: ORG_A } as const;

    it('allows an owner on their own organization', () => {
        expect(authorizer.can(owner, 'org.read', orgA)).toEqual({ kind: 'allowed' });
        expect(authorizer.can(owner, 'engine.remove', { kind: 'engine', orgId: ORG_A, engineId: 'e' })).toEqual({
            kind: 'allowed',
        });
    });

    it('denies a non-member with not-member', () => {
        expect(authorizer.can(owner, 'org.read', { kind: 'org', orgId: ORG_B })).toEqual({
            kind: 'denied',
            reason: 'not-member',
        });
        expect(authorizer.can(owner, 'engine.remove', { kind: 'engine', orgId: ORG_B, engineId: 'e' })).toEqual({
            kind: 'denied',
            reason: 'not-member',
        });
    });

    it('denies a role the action does not list', () => {
        expect(authorizer.can(owner, 'org.nobody', orgA)).toEqual({ kind: 'denied', reason: 'role' });
    });

    it('denies org actions on resources outside any organization', () => {
        const admin = { ...owner, platformRole: 'admin' } as const;
        expect(authorizer.can(admin, 'org.read', { kind: 'platform' })).toEqual({ kind: 'denied', reason: 'role' });
        expect(authorizer.can(owner, 'org.read', { kind: 'account', userId: USER })).toEqual({
            kind: 'denied',
            reason: 'role',
        });
    });

    it('allows self actions only on the actor’s own account', () => {
        expect(authorizer.can(owner, 'passkey.manage', { kind: 'account', userId: USER })).toEqual({ kind: 'allowed' });
        expect(authorizer.can(owner, 'passkey.manage', { kind: 'account', userId: OTHER_USER })).toEqual({
            kind: 'denied',
            reason: 'not-self',
        });
        expect(authorizer.can(owner, 'passkey.manage', orgA)).toEqual({ kind: 'denied', reason: 'not-self' });
    });

    it('denies a platform action to a normal user and asks a platform admin for a fresh step-up', () => {
        expect(authorizer.can(owner, 'platform.engines.suspend', { kind: 'platform' })).toEqual({
            kind: 'denied',
            reason: 'platform-admin-only',
        });
        const admin = { ...owner, platformRole: 'admin' } as const;
        expect(authorizer.can(admin, 'platform.engines.suspend', { kind: 'platform' })).toEqual({
            kind: 'denied',
            reason: 'step-up-required',
        });
        now = RECOVERED_AT;
        const stepped = { ...admin, steppedUpAt: now };
        expect(authorizer.can(stepped, 'platform.engines.suspend', { kind: 'platform' })).toEqual({ kind: 'allowed' });
        now += STEP_UP_WINDOW_MS;
        expect(STEP_UP_WINDOW_MS).toBe(5 * 60 * 1000);
        expect(authorizer.can(stepped, 'platform.engines.suspend', orgA)).toEqual({ kind: 'allowed' });
        now += 1;
        expect(authorizer.can(stepped, 'platform.engines.suspend', { kind: 'platform' })).toEqual({
            kind: 'denied',
            reason: 'step-up-required',
        });
    });

    it('denies a sensitive action for 72 hours after recovery', () => {
        const recovered = { ...owner, recoveredAt: RECOVERED_AT };
        now = RECOVERED_AT + 71 * HOUR + 59 * 60 * 1000;
        expect(authorizer.can(recovered, 'engine.remove', orgA)).toEqual({
            kind: 'denied',
            reason: 'recovery-cooldown',
        });
        expect(authorizer.can(recovered, 'org.read', orgA)).toEqual({ kind: 'allowed' });
        now = RECOVERED_AT + RECOVERY_COOLDOWN_MS;
        expect(RECOVERY_COOLDOWN_MS).toBe(72 * HOUR);
        expect(authorizer.can(recovered, 'engine.remove', orgA)).toEqual({ kind: 'allowed' });
    });

    it('denies an action missing from the table at runtime', () => {
        const untyped = authorizer as unknown as { can(a: Actor, action: string, r: unknown): unknown };
        expect(untyped.can(owner, 'toString', orgA)).toEqual({ kind: 'denied', reason: 'role' });
    });

    it('derives the org permissions of a role, for capability rendering', () => {
        expect(orgPermissions(testPolicy, 'owner')).toEqual(['org.read', 'engine.remove']);
    });
});

describe('DASHBOARD_POLICY', () => {
    const authorizer = createAuthorizer({ clock: { nowMs: () => RECOVERED_AT }, policy: DASHBOARD_POLICY });
    const recovered = { ...owner, recoveredAt: RECOVERED_AT };

    it('lets owners read their org and everyone manage their own passkeys and sessions', () => {
        expect(authorizer.can(owner, 'org.read', { kind: 'org', orgId: ORG_A })).toEqual({ kind: 'allowed' });
        for (const action of ['passkey.manage', 'session.manage'] as const) {
            expect(authorizer.can(recovered, action, { kind: 'account', userId: USER })).toEqual({ kind: 'allowed' });
        }
    });

    it.each(['engine.remove', 'engine.hostnames.manage', 'billing.owner.change'] as const)(
        'flags %s as sensitive, so the recovery cooldown denies it',
        (action) => {
            expect(authorizer.can(recovered, action, { kind: 'org', orgId: ORG_A })).toEqual({
                kind: 'denied',
                reason: 'recovery-cooldown',
            });
            expect(authorizer.can(owner, action, { kind: 'org', orgId: ORG_A })).toEqual({ kind: 'allowed' });
        },
    );

    it.each(['billing.read', 'billing.manage'] as const)(
        'lets an owner use %s on their own organization only, also right after a recovery',
        (action) => {
            expect(authorizer.can(recovered, action, { kind: 'org', orgId: ORG_A })).toEqual({ kind: 'allowed' });
            expect(authorizer.can(owner, action, { kind: 'org', orgId: ORG_B })).toEqual({
                kind: 'denied',
                reason: 'not-member',
            });
            expect(orgPermissions(DASHBOARD_POLICY, 'owner')).toContain(action);
        },
    );

    it('lets only an owner of the organization link engines to it, also right after a recovery', () => {
        expect(authorizer.can(recovered, 'engine.link', { kind: 'org', orgId: ORG_A })).toEqual({ kind: 'allowed' });
        expect(authorizer.can(owner, 'engine.link', { kind: 'org', orgId: ORG_B })).toEqual({
            kind: 'denied',
            reason: 'not-member',
        });
        expect(orgPermissions(DASHBOARD_POLICY, 'owner')).toContain('engine.link');
    });

    it('lets an owner read the organization’s engines, also right after a recovery, and no other organization’s', () => {
        const engine = { kind: 'engine', orgId: ORG_A, engineId: 'e' } as const;
        expect(authorizer.can(recovered, 'engine.read', engine)).toEqual({ kind: 'allowed' });
        expect(authorizer.can(owner, 'engine.read', { ...engine, orgId: ORG_B })).toEqual({
            kind: 'denied',
            reason: 'not-member',
        });
        expect(orgPermissions(DASHBOARD_POLICY, 'owner')).toEqual(
            expect.arrayContaining(['engine.read', 'engine.revoke']),
        );
    });

    it('lets an owner revoke an engine only outside the recovery cooldown and with a fresh step-up', () => {
        const engine = { kind: 'engine', orgId: ORG_A, engineId: 'e' } as const;
        const steppedUp = { ...owner, steppedUpAt: RECOVERED_AT };
        expect(authorizer.can(owner, 'engine.revoke', engine)).toEqual({ kind: 'denied', reason: 'step-up-required' });
        expect(authorizer.can({ ...steppedUp, recoveredAt: RECOVERED_AT }, 'engine.revoke', engine)).toEqual({
            kind: 'denied',
            reason: 'recovery-cooldown',
        });
        expect(authorizer.can(steppedUp, 'engine.revoke', { ...engine, orgId: ORG_B })).toEqual({
            kind: 'denied',
            reason: 'not-member',
        });
        expect(authorizer.can(steppedUp, 'engine.revoke', engine)).toEqual({ kind: 'allowed' });
    });

    // The teams spec's role table (ADR 0018), action by action, so a widened row fails here and not in review.
    it.each<[DashboardAction, readonly OrgRole[]]>([
        ['team.read', ['owner', 'admin', 'member']],
        ['team.leave', ['owner', 'admin', 'member']],
        ['org.leave', ['owner', 'admin', 'member']],
        ['team.manage', ['owner', 'admin']],
        ['team.delete', ['owner', 'admin']],
        ['team.members.manage', ['owner', 'admin']],
        ['engine.link', ['owner', 'admin']],
        ['org.members.read', ['owner', 'admin']],
        ['org.members.manage', ['owner', 'admin']],
        ['org.roles.manage', ['owner']],
        ['billing.read', ['owner']],
        ['billing.manage', ['owner']],
        ['billing.owner.change', ['owner']],
    ])('gives %s to exactly %j', (action, roles) => {
        const resource = { kind: 'org', orgId: ORG_A } as const;
        for (const orgRole of ['owner', 'admin', 'member'] as const) {
            const actor = { ...owner, orgRole, steppedUpAt: RECOVERED_AT };
            expect([orgRole, authorizer.can(actor, action, resource).kind]).toEqual([
                orgRole,
                roles.includes(orgRole) ? 'allowed' : 'denied',
            ]);
        }
    });

    it('marks adding and removing people sensitive, so a recovered account waits out the cooldown', () => {
        for (const action of ['team.members.manage', 'org.members.manage', 'org.roles.manage'] as const) {
            expect(authorizer.can(recovered, action, { kind: 'org', orgId: ORG_A })).toEqual({
                kind: 'denied',
                reason: 'recovery-cooldown',
            });
        }
    });

    it('keeps the billing problem list to platform admins', () => {
        expect(authorizer.can(owner, 'admin.billing.read', { kind: 'platform' })).toEqual({
            kind: 'denied',
            reason: 'platform-admin-only',
        });
        expect(authorizer.can({ ...owner, platformRole: 'admin' }, 'admin.billing.read', { kind: 'platform' })).toEqual(
            {
                kind: 'allowed',
            },
        );
        expect(orgPermissions(DASHBOARD_POLICY, 'owner')).not.toContain('admin.billing.read');
    });
});
