import type { MemberId, OrgId, Permission, Role } from '@ptbk/engine-api';
import { useSuspenseQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { knownPermissions } from './permissions';
import { meQueryOptions } from './session-queries';

export interface CurrentMember {
    readonly memberId: MemberId;
    readonly displayName: string;
    readonly orgId: OrgId;
    /** For display only. Code decides by `permissions` (through `usePermissions()`), never by role. */
    readonly roleLabel: Role;
    readonly permissions: ReadonlySet<Permission>;
}

export function useCurrentMember(): CurrentMember {
    const { data } = useSuspenseQuery(meQueryOptions(useEngineApi()));
    return {
        memberId: data.memberId,
        displayName: data.displayName,
        orgId: data.orgId,
        roleLabel: data.role,
        permissions: knownPermissions(data.permissions),
    };
}
