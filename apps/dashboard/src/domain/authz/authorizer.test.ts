import { describe, expect, it } from 'vitest';

import { orgIdSchema, userIdSchema } from '../ids';
import { createAuthorizer, RECOVERY_COOLDOWN_MS, type Actor, type PolicyTable } from './authorizer';
import { DASHBOARD_POLICY } from './policy';

const ORG_A = orgIdSchema.parse('aaaaaaaaaaaaaaaaaaaaaaaaaa');
const ORG_B = orgIdSchema.parse('bbbbbbbbbbbbbbbbbbbbbbbbbb');
const owner: Actor = {
    userId: userIdSchema.parse('uuuuuuuuuuuuuuuuuuuuuuuuuu'),
    orgId: ORG_A,
    orgRole: 'owner',
    platformRole: 'none',
    recoveredAt: null,
};

const testPolicy = {
    'org.read': { orgRoles: ['owner'], platformAdminOnly: false, sensitive: false },
    'org.nobody': { orgRoles: [], platformAdminOnly: false, sensitive: false },
    'engine.remove': { orgRoles: ['owner'], platformAdminOnly: false, sensitive: true },
    'platform.engines.suspend': { orgRoles: [], platformAdminOnly: true, sensitive: false },
} as const satisfies PolicyTable<string>;

const HOUR = 60 * 60 * 1000;
const RECOVERED_AT = 1_000 * HOUR;

describe('Authorizer', () => {
    let now = RECOVERED_AT;
    const clock = { nowMs: () => now };
    const authorizer = createAuthorizer({ clock, policy: testPolicy });

    it('allows an owner on their own organization', () => {
        expect(authorizer.can(owner, 'org.read', { kind: 'org', orgId: ORG_A })).toEqual({ kind: 'allowed' });
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
        expect(authorizer.can(owner, 'org.nobody', { kind: 'org', orgId: ORG_A })).toEqual({
            kind: 'denied',
            reason: 'role',
        });
    });

    it('denies a platform-only action to a normal user and allows it to a platform admin', () => {
        expect(authorizer.can(owner, 'platform.engines.suspend', { kind: 'platform' })).toEqual({
            kind: 'denied',
            reason: 'platform-admin-only',
        });
        expect(
            authorizer.can({ ...owner, platformRole: 'admin' }, 'platform.engines.suspend', { kind: 'platform' }),
        ).toEqual({ kind: 'allowed' });
    });

    it('denies org actions on the platform resource', () => {
        expect(authorizer.can({ ...owner, platformRole: 'admin' }, 'org.read', { kind: 'platform' })).toEqual({
            kind: 'denied',
            reason: 'platform-admin-only',
        });
    });

    it('denies a sensitive action for 72 hours after recovery', () => {
        const recovered = { ...owner, recoveredAt: RECOVERED_AT };
        const resource = { kind: 'org', orgId: ORG_A } as const;
        now = RECOVERED_AT + 71 * HOUR + 59 * 60 * 1000;
        expect(authorizer.can(recovered, 'engine.remove', resource)).toEqual({
            kind: 'denied',
            reason: 'recovery-cooldown',
        });
        expect(authorizer.can(recovered, 'org.read', resource)).toEqual({ kind: 'allowed' });
        now = RECOVERED_AT + RECOVERY_COOLDOWN_MS;
        expect(RECOVERY_COOLDOWN_MS).toBe(72 * HOUR);
        expect(authorizer.can(recovered, 'engine.remove', resource)).toEqual({ kind: 'allowed' });
    });

    it('denies an action missing from the table at runtime', () => {
        const untyped = authorizer as unknown as { can(a: Actor, action: string, r: unknown): unknown };
        expect(untyped.can(owner, 'toString', { kind: 'org', orgId: ORG_A })).toEqual({
            kind: 'denied',
            reason: 'role',
        });
    });

    it('starts the dashboard policy with org.read for owners', () => {
        const dashboard = createAuthorizer({ clock, policy: DASHBOARD_POLICY });
        expect(dashboard.can(owner, 'org.read', { kind: 'org', orgId: ORG_A })).toEqual({ kind: 'allowed' });
    });
});
