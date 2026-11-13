import { createFileRoute, redirect } from '@tanstack/react-router';

import { loadAccess } from '../app/registry/engine-access';
import { isAllowed } from '../app/registry/visibility';
import { HomeSearch } from '../features/home/activity/activity-areas';
import { activityFeedQueryOptions } from '../features/home/activity/activity-queries';
import { homeVariant } from '../features/home/home-variant';
import { ONBOARDING_REQUIREMENT } from '../features/onboarding/onboarding-feature';
import { onboardingQueryOptions } from '../features/onboarding/onboarding-queries';
import { HOME_CHATS, HomePage } from '../features/home/home-page';
import { AGENT_LOOK_PARAMS } from '../features/home/use-agent-look';
import { agentListQueryOptions } from '../features/agents/agents-queries';
import { chatListQueryOptions } from '../features/chat/chat-queries';
import { knownPermissions } from '../features/session/permissions';
import { meQueryOptions } from '../features/session/session-queries';

export const Route = createFileRoute('/')({
    validateSearch: HomeSearch,
    // A new engine opens on its setup, once: after "Skip for now" (`deferred`) home only offers it.
    beforeLoad: async ({ context }) => {
        if (!isAllowed(ONBOARDING_REQUIREMENT, await loadAccess(context))) return;
        const state = await context.queryClient.query(onboardingQueryOptions(context.engineApi)).catch(() => undefined);
        if (state?.status === 'pending' && !state.deferred) redirect({ to: '/onboarding', throw: true });
    },
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
        if (access.can('chats.read')) prefetch(queryClient.query(chatListQueryOptions(engineApi, HOME_CHATS)));
        if (access.can('agents.read')) {
            prefetch(queryClient.query(agentListQueryOptions(engineApi, AGENT_LOOK_PARAMS)));
            if (homeVariant(knownPermissions(me.permissions)) === 'control-center') {
                prefetch(queryClient.infiniteQuery(activityFeedQueryOptions(engineApi, deps.area)));
            }
        }
    },
    component: HomePage,
});
