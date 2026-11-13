import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { chatListQueryOptions } from '../chat/chat-queries';
import { OnboardingNotice } from '../onboarding/onboarding-notice';
import { useCurrentMember } from '../session/use-current-member';
import { ActivityFeed } from './activity/activity-feed';
import { AskChatter } from './ask-chatter';
import { HomeHeader } from './home-header';
import { homeVariant } from './home-variant';
import { NeedsYou } from './needs-you';
import { RecentChats } from './recent-chats';
import { UpdateBanner } from './update-banner';
import { WorkingNow } from './working-now';
import { m } from '../../paraglide/messages';

/** Every thread the member can see, newest first: the one list Needs you, Working now and Recent chats all read. */
export const HOME_CHATS = {} as const;

/**
 * The first screen after sign-in, Chatter-first: ask anything, then what waits on you, what is running and your recent
 * chats. Members who oversee the engine also get update notices and the activity feed, in a quiet side column on
 * wide screens and after everything else on narrow ones.
 */
export function HomePage() {
    const { permissions } = useCurrentMember();
    const oversees = homeVariant(permissions) === 'control-center';
    const chatsVisible = useAllows({ permission: 'chats.read' });
    const canAsk = useAllows({ permission: 'chats.write' });
    // The feed (`GET /activity`) needs `agents.read` too: activity is about agents.
    const activityVisible = useAllows({ permission: 'agents.read' }) && oversees;
    const chats = useQuery({ ...chatListQueryOptions(useEngineApi(), HOME_CHATS), enabled: chatsVisible });
    const items = chatsVisible ? chats.data?.items : [];
    return (
        <div className="grid grid-cols-1 gap-x-12 gap-y-10 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <section aria-labelledby="page-title" className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-8 pt-6">
                <HomeHeader now={new Date()} />
                {canAsk ? <AskChatter /> : null}
                {oversees ? <UpdateBanner /> : null}
                <OnboardingNotice />
                <NeedsYou chats={items} />
                <WorkingNow chats={items} />
                {chatsVisible ? <RecentChats chats={items} failed={chats.isError} /> : null}
            </section>
            {activityVisible ? (
                <aside
                    aria-label={m.activity_title()}
                    className="min-w-0 xl:sticky xl:top-4 xl:max-h-[calc(100dvh-2rem)] xl:overflow-y-auto xl:pt-6 xl:scroll-quiet"
                >
                    <ActivityFeed />
                </aside>
            ) : null}
        </div>
    );
}
