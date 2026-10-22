import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { loadAccess } from '../app/registry/engine-access';
import { isAllowed } from '../app/registry/visibility';
import { HomeSearch } from '../features/home/activity/activity-areas';
import { activityFeedQueryOptions } from '../features/home/activity/activity-queries';
import { homeVariant } from '../features/home/home-variant';
import { HomePage } from '../features/home/home-page';
import {
    memberAgentsQueryOptions,
    recentAgentsQueryOptions,
    recentChatsQueryOptions,
} from '../features/home/home-queries';
import { knownPermissions } from '../features/session/permissions';
import { meQueryOptions } from '../features/session/session-queries';
import { runStatsQueryOptions } from '../features/runs/runs-queries';

export const Route = createFileRoute('/')({
    validateSearch: HomeSearch,
    loaderDeps: ({ search }) => ({ area: search.activity ?? null }),
    // Prefetches without waiting: each widget shows its own skeleton and error, so no endpoint holds up the others.
    loader: async ({ context, deps }) => {
        const { queryClient, engineApi } = context;
        const prefetch = (promise: Promise<unknown>) => {
            promise.catch(() => undefined);
        };
        const [access, me] = await Promise.all([
            loadAccess(context),
            queryClient.query({ ...meQueryOptions(engineApi), staleTime: 'static' }),
        ]);
        if (homeVariant(knownPermissions(me.permissions)) === 'control-center') {
            if (access.can('agents.read')) {
                prefetch(queryClient.infiniteQuery(activityFeedQueryOptions(engineApi, deps.area)));
                prefetch(queryClient.query(recentAgentsQueryOptions(engineApi)));
            }
            if (isAllowed({ capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' }, access)) {
                prefetch(queryClient.query(runStatsQueryOptions(engineApi)));
            }
        } else {
            if (access.can('agents.read')) prefetch(queryClient.query(memberAgentsQueryOptions(engineApi)));
            if (access.can('chats.read')) prefetch(queryClient.query(recentChatsQueryOptions(engineApi)));
        }
    },
    component: HomePage,
});
