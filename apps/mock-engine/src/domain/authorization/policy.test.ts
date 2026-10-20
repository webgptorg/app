import type { Permission } from '@ptbk/engine-api';
import { PERMISSIONS, ROLES, isReadPermission } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { ROLE_PERMISSIONS, decideOwnership, permissionsFor } from './policy';

const sorted = (permissions: Iterable<Permission>) => [...permissions].sort();

describe('permissionsFor', () => {
    it('gives the owner every permission', () => {
        expect(sorted(permissionsFor({ role: 'owner' }, { permissions: null }))).toEqual([...PERMISSIONS].sort());
    });

    it('gives an admin everything but settings.manage', () => {
        const admin = permissionsFor({ role: 'admin' }, { permissions: null });
        expect(admin.has('settings.manage')).toBe(false);
        expect(admin.size).toBe(PERMISSIONS.length - 1);
    });

    it('keeps members away from secrets.manage, members.manage and settings', () => {
        const member = permissionsFor({ role: 'member' }, { permissions: null });
        for (const permission of ['secrets.manage', 'members.manage', 'settings.manage', 'audit.read'] as const) {
            expect(member.has(permission)).toBe(false);
        }
        expect(member.has('secrets.read')).toBe(true);
        expect(member.has('agents.write')).toBe(true);
    });

    it('gives viewers only read permissions', () => {
        const viewer = permissionsFor({ role: 'viewer' }, { permissions: null });
        expect(viewer.size).toBeGreaterThan(0);
        expect([...viewer].every(isReadPermission)).toBe(true);
        expect(viewer.has('secrets.read')).toBe(false);
    });

    it('lists only known permissions for every role, without duplicates', () => {
        for (const role of ROLES) {
            const listed = ROLE_PERMISSIONS[role];
            expect(new Set(listed).size).toBe(listed.length);
            for (const permission of listed) expect(PERMISSIONS).toContain(permission);
        }
    });

    it('lets an explicit session set win over the role', () => {
        expect(sorted(permissionsFor({ role: 'owner' }, { permissions: ['agents.read'] }))).toEqual(['agents.read']);
        expect(permissionsFor({ role: 'viewer' }, { permissions: [] }).size).toBe(0);
    });
});

describe('decideOwnership', () => {
    const member = { memberId: 'member-a', permissions: permissionsFor({ role: 'member' }, { permissions: null }) };
    const admin = { memberId: 'member-admin', permissions: permissionsFor({ role: 'admin' }, { permissions: null }) };
    const agent = (createdBy?: string | null) => ({
        kind: 'agent',
        id: 'agent-1',
        ...(createdBy === undefined ? {} : { createdBy }),
    });

    it('lets a member change their own agent', () => {
        for (const permission of ['agents.write', 'agents.delete', 'agents.run'] as const) {
            expect(decideOwnership(member, permission, agent('member-a'))).toEqual({ kind: 'allow' });
        }
    });

    it("denies a member changing another member's agent", () => {
        for (const permission of ['agents.write', 'agents.delete', 'agents.run'] as const) {
            expect(decideOwnership(member, permission, agent('member-b'))).toEqual({
                kind: 'deny',
                reason: 'not-owner',
            });
        }
    });

    it('lets members.manage holders change anyone’s agent', () => {
        expect(decideOwnership(admin, 'agents.write', agent('member-b'))).toEqual({ kind: 'allow' });
    });

    it('never denies reading or chatting by ownership', () => {
        expect(decideOwnership(member, 'agents.read', agent('member-b'))).toEqual({ kind: 'allow' });
        expect(decideOwnership(member, 'chats.write', agent('member-b'))).toEqual({ kind: 'allow' });
    });

    it('applies ownership to agents only', () => {
        expect(decideOwnership(member, 'triggers.manage', { kind: 'trigger', id: 't', createdBy: 'member-b' })).toEqual(
            { kind: 'allow' },
        );
    });

    it('allows an unknown or ownerless resource and routes without one', () => {
        expect(decideOwnership(member, 'agents.write', agent())).toEqual({ kind: 'allow' });
        expect(decideOwnership(member, 'agents.write', agent(null))).toEqual({ kind: 'allow' });
        expect(decideOwnership(member, 'agents.write', null)).toEqual({ kind: 'allow' });
    });

    it('denies a missing permission first', () => {
        expect(decideOwnership(member, 'secrets.manage', null)).toEqual({ kind: 'deny', reason: 'missing-permission' });
        expect(decideOwnership(member, 'settings.manage', agent('member-a'))).toEqual({
            kind: 'deny',
            reason: 'missing-permission',
        });
    });
});
