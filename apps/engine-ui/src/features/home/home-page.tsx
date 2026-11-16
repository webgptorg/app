import { Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { chatListQueryOptions } from '../chat/chat-queries';
import { OnboardingNotice } from '../onboarding/onboarding-notice';
import { useCurrentMember } from '../session/use-current-member';
import { HomeHeader } from './home-header';
import { homeVariant } from './home-variant';
import { UpdateBanner } from './update-banner';

/** Every thread the member can see, newest first: the one list Needs you, Working now and Recent chats all read. */
export const HOME_CHATS = {} as const;

/** Home's content and its activity feed load as chunks of their own; the route loader starts both with the data. */
export const loadHomeContent = () => import('./home-content');
export const loadActivityFeed = () => import('./activity/activity-feed');
const HomeContent = lazy(() => loadHomeContent().then((module) => ({ default: module.HomeContent })));
const ActivityFeed = lazy(() => loadActivityFeed().then((module) => ({ default: module.ActivityFeed })));

/**
 * The first screen after sign-in, Chatter-first: ask anything, then what waits on you, what is running and your recent
 * chats. Members who oversee the engine also get update notices and, last, the recent activity as table-like rows.
 */
export function HomePage() {
    const { permissions } = useCurrentMember();
    const oversees = homeVariant(permissions) === 'control-center';
    const chatsVisible = useAllows({ permission: 'chats.read' });
    const canAsk = useAllows({ permission: 'chats.write' });
    // The feed (`GET /activity`) needs `agents.read` too: activity is about agents.
    const activityVisible = useAllows({ permission: 'agents.read' }) && oversees;
    const chats = useQuery({ ...chatListQueryOptions(useEngineApi(), HOME_CHATS), enabled: chatsVisible });
    return (
        <section aria-labelledby="page-title" className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-8 pt-6">
            <HomeHeader now={new Date()} />
            {oversees ? <UpdateBanner /> : null}
            <OnboardingNotice />
            <Suspense fallback={<ContentFallback canAsk={canAsk} />}>
                <HomeContent
                    canAsk={canAsk}
                    chatsVisible={chatsVisible}
                    chats={chatsVisible ? chats.data?.items : []}
                    chatsFailed={chats.isError}
                />
            </Suspense>
            {activityVisible ? (
                <Suspense fallback={<Skeleton shape="block" className="h-40 w-full" />}>
                    <ActivityFeed />
                </Suspense>
            ) : null}
        </section>
    );
}

/** The composer's and the sections' shapes, for the moment their chunk takes to arrive, so nothing jumps. */
function ContentFallback({ canAsk }: { readonly canAsk: boolean }) {
    return (
        <div aria-busy="true" className="flex flex-col gap-8">
            {canAsk ? <Skeleton shape="block" className="h-13 w-full rounded-[1.5rem]" /> : null}
            <Skeleton shape="block" className="h-24 w-full" />
            <Skeleton shape="block" className="h-24 w-full" />
        </div>
    );
}
