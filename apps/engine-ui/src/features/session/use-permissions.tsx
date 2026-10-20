import type { Permission } from '@ptbk/engine-api';
import type { ReactNode } from 'react';

import type { Can as CanFn } from './permissions';
import { useCurrentMember } from './use-current-member';

export interface Permissions {
    readonly can: CanFn;
}

/** What the current member may do. The engine enforces every permission; the UI only avoids offering what it refuses. */
export function usePermissions(): Permissions {
    const { permissions } = useCurrentMember();
    return { can: (permission) => permissions.has(permission) };
}

export interface CanProps {
    readonly permission: Permission;
    readonly children: ReactNode;
    /** Rendered instead when the member lacks the permission; nothing by default. */
    readonly fallback?: ReactNode;
}

export function Can({ permission, children, fallback = null }: CanProps) {
    return usePermissions().can(permission) ? children : fallback;
}
