import { z } from 'zod';

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

/**
 * Closed list of capabilities. The UI and every handler decide by permission, never by role name; which role holds
 * which permission is engine policy, except that `owner` holds all of them. Adding a permission is additive, renaming
 * one is breaking.
 */
export const PERMISSIONS = [
    'agents.read',
    'agents.write',
    'agents.delete',
    'agents.run',
    'chats.read',
    'chats.write',
    'files.read',
    'files.write',
    /** Secret metadata only; no permission makes a secret value readable. */
    'secrets.read',
    'secrets.manage',
    'members.read',
    /** Also covers revoking another member's passkeys and sessions. */
    'members.manage',
    'api-tokens.manage',
    /** Includes the update policy. */
    'settings.manage',
    'security.read',
    'audit.read',
] as const;
export const Permission = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof Permission>;

export const OWNER_PERMISSIONS: readonly Permission[] = PERMISSIONS;

export function isReadPermission(permission: Permission): boolean {
    return permission.endsWith('.read');
}
