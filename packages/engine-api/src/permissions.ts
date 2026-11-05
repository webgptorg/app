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
    /** Wallet logins without secrets and pending requests; no permission makes a password readable. */
    'wallet.read',
    /** Add, update and remove logins; mark requests as seen or reject them. */
    'wallet.manage',
    'members.read',
    /** Also covers revoking another member's passkeys and sessions. */
    'members.manage',
    'api-tokens.manage',
    /** Includes the update policy. */
    'settings.manage',
    'security.read',
    'audit.read',
    'runs.read',
    /** Cancel and retry. */
    'runs.control',
    'tasks.read',
    'triggers.read',
    'triggers.manage',
    'integrations.read',
    'integrations.manage',
    /** Driving an engine browser tab by hand (`browser-tab@1`); engine policy gives it to owners only. */
    'browser.control',
] as const;
export const Permission = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof Permission>;

export const OWNER_PERMISSIONS: readonly Permission[] = PERMISSIONS;

export function isReadPermission(permission: Permission): boolean {
    return permission.endsWith('.read');
}
