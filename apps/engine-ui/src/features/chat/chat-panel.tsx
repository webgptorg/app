import type { ReadChat } from '@ptbk/engine-api';
import { EmptyState, ErrorState } from '@ptbk/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { useCurrentMember } from '../session/use-current-member';
import { messagesInOrder } from './chat-cache';
import { chatMessagesQueryOptions } from './chat-queries';
import { MessagesSkeleton } from './chat-route-states';
import { isReplyActive } from './chat-session';
import { Composer } from './composer';
import { MessageList } from './message-list';
import { messageViews } from './message-views';
import { useChatSession } from './use-chat-session';

/** Long histories mount only the visible window; below this every message stays in the page for find-in-page. */
export const VIRTUALIZE_ABOVE = 200;

export interface ChatPanelProps {
    readonly chat: ReadChat;
    readonly agentName: string;
    /** The member may write here: `chats.write`, and the chat is their own. */
    readonly canWrite: boolean;
    /** Take the rest of a parent flex column's height instead of a share of the screen. */
    readonly fill?: boolean;
}

/**
 * A chat's history, its composer and the reply in progress. Reusable wherever a chat is shown (the agent's Chat tab,
 * U-04's test step); it reads and writes only through the engine API client and the query cache.
 */
export function ChatPanel({ chat, agentName, canWrite, fill = false }: ChatPanelProps) {
    const engineApi = useEngineApi();
    const me = useCurrentMember();
    const history = useInfiniteQuery(chatMessagesQueryOptions(engineApi, chat.id));
    const messages = useMemo(() => messagesInOrder(history.data), [history.data]);
    const session = useChatSession({ chatId: chat.id, lastMessageAt: chat.lastMessageAt, messages });
    const views = useMemo(
        () => messageViews(messages, session.state, { memberId: me.memberId, canSendAgain: canWrite }),
        [messages, session.state, me.memberId, canWrite],
    );
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const active = isReplyActive(session.state.phase);
    const { completedCount } = session.state;
    // Once per finished reply, never per token; the trailing space makes a repeat count as a change.
    const announcement =
        completedCount === 0
            ? ''
            : `${m.chat_reply_finished({ name: agentName })}${completedCount % 2 === 0 ? ' ' : ''}`;

    const stop = () => {
        session.stop();
        textareaRef.current?.focus();
    };

    // Esc stops the reply from anywhere in the panel: the read-only composer, the history, the Stop button.
    const panelRef = useRef<HTMLDivElement>(null);
    const stopOnEscape = useRef<(event: KeyboardEvent) => void>(() => undefined);
    useEffect(() => {
        stopOnEscape.current = (event) => {
            if (event.key !== 'Escape' || !active || !canWrite) return;
            event.preventDefault();
            stop();
        };
    });
    useEffect(() => {
        const panel = panelRef.current;
        if (panel === null) return;
        const listener = (event: KeyboardEvent) => {
            stopOnEscape.current(event);
        };
        panel.addEventListener('keydown', listener);
        return () => {
            panel.removeEventListener('keydown', listener);
        };
    }, []);

    let body;
    if (history.isPending) {
        body = (
            <div aria-busy="true" className="min-h-0 flex-1">
                <span className="sr-only" role="status">
                    {m.loading()}
                </span>
                <MessagesSkeleton />
            </div>
        );
    } else if (history.isError) {
        body = (
            <ErrorState
                message={m.chat_history_failed()}
                onRetry={() => {
                    void history.refetch();
                }}
                retrying={history.isFetching}
            />
        );
    } else if (views.length === 0) {
        body = (
            <div className="flex min-h-0 flex-1 items-center justify-center">
                <EmptyState title={m.chat_history_empty()} />
            </div>
        );
    } else {
        body = (
            <MessageList
                label={m.chat_column_messages()}
                views={views}
                agentName={agentName}
                virtual={chat.messageCount > VIRTUALIZE_ABOVE}
                hasOlder={history.hasNextPage}
                loadingOlder={history.isFetchingNextPage}
                onLoadOlder={() => {
                    void history.fetchNextPage();
                }}
                onRetry={session.retry}
                onJumpedToLatest={() => {
                    textareaRef.current?.focus();
                }}
            />
        );
    }

    return (
        <div ref={panelRef} className={cx('flex flex-col gap-3', fill ? 'min-h-0 flex-1' : 'h-[70dvh] min-h-96')}>
            {body}
            <div aria-live="polite" aria-atomic="true" className="sr-only">
                {announcement}
            </div>
            {canWrite ? (
                <Composer
                    label={m.chat_composer_label()}
                    labelHidden
                    placeholder={m.chat_composer_placeholder({ name: agentName })}
                    busy={active}
                    {...(session.state.phase === 'streaming'
                        ? { stop: 'ready' as const }
                        : session.state.phase === 'stopping'
                          ? { stop: 'stopping' as const }
                          : {})}
                    onSend={session.send}
                    onStop={stop}
                    textareaRef={textareaRef}
                />
            ) : null}
        </div>
    );
}
