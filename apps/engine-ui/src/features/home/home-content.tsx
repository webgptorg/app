import type { ReadChat } from '@ptbk/engine-api';

import { AskChatter } from './ask-chatter';
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
 * Home below its greeting: the composer and the three sections. A chunk of its own, which the route loader starts
 * fetching alongside the data, so the chat composer, the chips and their hovercards stay out of the entry chunk.
 */
export function HomeContent({ canAsk, chatsVisible, chats, chatsFailed }: HomeContentProps) {
    return (
        <>
            {canAsk ? <AskChatter /> : null}
            <NeedsYou chats={chats} />
            <WorkingNow chats={chats} />
            {chatsVisible ? <RecentChats chats={chats} failed={chatsFailed} /> : null}
        </>
    );
}
