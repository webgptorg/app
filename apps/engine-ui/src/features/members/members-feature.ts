import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { MemberActivityItem, memberActivitySummary } from './member-activity';
import { accessRequestListQueryOptions } from './members-queries';

/** People waiting to be let in, so the nav says so on every page, not only on Members. */
function usePendingAccessRequests(): number {
    const supported = useAllows({ capability: KNOWN_CAPABILITIES.accessRequests, permission: 'members.manage' });
    const requests = useQuery({ ...accessRequestListQueryOptions(useEngineApi()), enabled: supported });
    return supported ? (requests.data?.items.length ?? 0) : 0;
}

export const membersFeature = defineFeature({
    id: 'members',
    requires: { permission: 'members.read' },
    nav: {
        group: 'admin',
        order: 10,
        label: m.nav_members,
        icon: Users,
        to: '/members',
        useBadge: usePendingAccessRequests,
    },
    activityRenderers: [
        { kind: 'member.*', versions: [1], component: MemberActivityItem, summary: memberActivitySummary },
    ],
});
