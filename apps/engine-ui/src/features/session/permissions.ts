import { PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';

const KNOWN: ReadonlySet<string> = new Set(PERMISSIONS);

/** The permissions this UI knows, from whatever the engine sent: a newer engine's unknown strings are dropped. */
export function knownPermissions(granted: readonly string[]): ReadonlySet<Permission> {
    return new Set(granted.filter((permission): permission is Permission => KNOWN.has(permission)));
}

export type Can = (permission: Permission) => boolean;

/** Deny by default: only a permission in the member's list is allowed. */
export function createCan(granted: readonly string[]): Can {
    const known = knownPermissions(granted);
    return (permission) => known.has(permission);
}
