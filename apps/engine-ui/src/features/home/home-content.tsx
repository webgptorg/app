import type { ReadChat } from '@ptbk/engine-api';

import { AskChatter } from './ask-chatter';
import { ASK_CHATTER_ID, HomeGuide } from './home-guide';
import { NeedsYou } from './needs-you';
import { RecentChats } from './recent-chats';
import { WorkingNow } from './working-now';

export interface HomeContentProps {
    readonly canAsk: boolean;
    readonly chatsVisible: boolean;
    /** `undefined` while loading; `[]` without `chats.read`. */
    readonly chats: readonly ReadChat[] | undefined;
    readonly chatsFailed: boolean;
}

/**
 * Home below its greeting: the robot's next step, the composer and the three sections. A chunk of its own, which the route loader starts
 * fetching alongside the data, so the chat composer, the chips and their hovercards stay out of the entry chunk.
 */
export function HomeContent({ canAsk, chatsVisible, chats, chatsFailed }: HomeContentProps) {
    return (
        <>
            <HomeGuide chats={chatsVisible ? chats : []} canAsk={canAsk && chatsVisible && !chatsFailed} />
            {canAsk ? (
                <div id={ASK_CHATTER_ID}>
                    <AskChatter />
                </div>
            ) : null}
            <NeedsYou chats={chats} />
            <WorkingNow chats={chats} />
            {chatsVisible ? <RecentChats chats={chats} failed={chatsFailed} /> : null}
        </>
    );
}
