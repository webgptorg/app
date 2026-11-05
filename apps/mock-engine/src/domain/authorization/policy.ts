import type { Permission, Role } from '@ptbk/engine-api';
import { OWNER_PERMISSIONS } from '@ptbk/engine-api';

/**
 * The mock engine's role policy, deny by default: a role holds exactly the permissions listed here. C-04 fixes only
 * that `owner` holds every permission; the rest is the mock's guess at engine policy, to align with the engine team
 * before E-01. Nothing outside this module looks at role names.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
    owner: OWNER_PERMISSIONS,
    // Driving a browser tab signs in as the engine's own accounts, so it stays with owners.
    admin: OWNER_PERMISSIONS.filter(
        (permission) => permission !== 'settings.manage' && permission !== 'browser.control',
    ),
    member: [
        'agents.read',
        'agents.write',
        'agents.delete',
        'agents.run',
        'chats.read',
        'chats.write',
        'files.read',
        'files.write',
        'secrets.read',
        'members.read',
        'runs.read',
        'runs.control',
        'tasks.read',
        'triggers.read',
        'triggers.manage',
        'integrations.read',
    ],
    viewer: [
        'agents.read',
        'chats.read',
        'files.read',
        'members.read',
        'runs.read',
        'tasks.read',
        'triggers.read',
        'integrations.read',
    ],
});

/** A session created with an explicit permission set (`/__mock/sessions`) holds exactly that set, whatever the role. */
export function permissionsFor(
    member: { readonly role: Role },
    session: { readonly permissions: readonly Permission[] | null },
): ReadonlySet<Permission> {
    return new Set(session.permissions ?? ROLE_PERMISSIONS[member.role]);
}

export type OwnershipDecision = { readonly kind: 'allow' } | { readonly kind: 'deny'; readonly reason: string };

/** Changing an agent, as opposed to reading or chatting with it. */
const AGENT_CHANGES: ReadonlySet<Permission> = new Set(['agents.write', 'agents.delete', 'agents.run']);

/**
 * The core's permission check plus the mock's one addition, ownership: without `members.manage` a member changes only
 * agents they created. An unknown `createdBy` is allowed through, so the core answers 404 for an unknown ID.
 */
export function decideOwnership(
    actor: { readonly memberId: string; readonly permissions: ReadonlySet<Permission> },
    permission: Permission,
    resource: { readonly kind: string; readonly id: string; readonly createdBy?: string | null } | null,
): OwnershipDecision {
    if (!actor.permissions.has(permission)) return { kind: 'deny', reason: 'missing-permission' };
    if (
        resource?.kind === 'agent' &&
        typeof resource.createdBy === 'string' &&
        resource.createdBy !== actor.memberId &&
        AGENT_CHANGES.has(permission) &&
        !actor.permissions.has('members.manage')
    ) {
        return { kind: 'deny', reason: 'not-owner' };
    }
    return { kind: 'allow' };
}
