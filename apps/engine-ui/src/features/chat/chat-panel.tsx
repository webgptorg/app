import { KNOWN_CAPABILITIES, MessageId } from '@ptbk/engine-api';
import type { ReadChat } from '@ptbk/engine-api';
import { EmptyState, ErrorState } from '@ptbk/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { agentListQueryOptions } from '../agents/agents-queries';
import { useCurrentMember } from '../session/use-current-member';
import { usePermissions } from '../session/use-permissions';
import { entriesInOrder } from './chat-cache';
import { chatKeys } from './chat-keys';
import { chatEntriesQueryOptions } from './chat-queries';
import { MessagesSkeleton } from './chat-route-states';
import { isReplyActive } from './chat-session';
import { Composer } from './composer';
import type { ComposerAgent } from './composer';
import { MessageList } from './message-list';
import { threadViews } from './message-views';
import { buildThreadReferences, ThreadReferencesProvider } from './references/thread-references';
import { useChatSession } from './use-chat-session';

/** Long histories mount only the visible window; below this every message stays in the page for find-in-page. */
export const VIRTUALIZE_ABOVE = 200;
/** The project's agents `@` can name: the engine's largest page, sorted by name. */
const MENTIONABLE_AGENTS = 100;

export interface ChatPanelProps {
    readonly chat: ReadChat;
    /** The member may write here: `chats.write`. Nobody owns a thread. */
    readonly canWrite: boolean;
    /** Take the rest of a parent flex column's height instead of a share of the screen. */
    readonly fill?: boolean;
}

/** The agent a new message goes to unless it answers a question: the thread's first agent. */
function mainAgentName(chat: ReadChat): string | undefined {
    return chat.members.find((member) => member.kind === 'agent')?.name;
}

/**
 * A thread's entries, its composer and the reply in progress. Reusable wherever a thread is shown (the Chats page,
 * U-04's test step); it reads and writes only through the engine API client and the query cache. Opening it marks the
 * thread read for this member; a question counts as seen only once it is on screen.
 */
export function ChatPanel({ chat, canWrite, fill = false }: ChatPanelProps) {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const me = useCurrentMember();
    const history = useInfiniteQuery(chatEntriesQueryOptions(engineApi, chat.id));
    const entries = useMemo(() => entriesInOrder(history.data), [history.data]);
    const session = useChatSession({ chatId: chat.id, updatedAt: chat.updatedAt, entries });
    const views = useMemo(
        () => threadViews(chat, entries, session.state, { memberId: me.memberId, canSendAgain: canWrite }),
        [chat, entries, session.state, me.memberId, canWrite],
    );
    const { can } = usePermissions();
    const projectAgents = useQuery({
        ...agentListQueryOptions(engineApi, { sort: 'name', limit: MENTIONABLE_AGENTS }),
        enabled: can('agents.read'),
    });
    const canOpenTasks = useAllows({ capability: KNOWN_CAPABILITIES.tasks, permission: 'tasks.read' });
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [addressee, setAddressee] = useState<ComposerAgent | null>(null);
    // Addressing an agent from a chip or a hovercard leads straight on to writing to it.
    useEffect(() => {
        if (addressee !== null) textareaRef.current?.focus();
    }, [addressee]);
    const references = useMemo(
        () =>
            buildThreadReferences({
                chat,
                agents: projectAgents.data?.items ?? [],
                canOpenTasks,
                onMention: canWrite ? setAddressee : undefined,
            }),
        [chat, projectAgents.data, canOpenTasks, canWrite],
    );
    const mentionables = useMemo(() => [...references.agents.values()], [references]);
    const mainName = mainAgentName(chat) ?? m.chat_agents();
    const agentName = addressee?.name ?? mainName;

    const { unread } = chat;
    useEffect(() => {
        if (unread === 0) return;
        void (async () => {
            const read = await engineApi.chats.markRead(chat.id, AbortSignal.timeout(10_000)).catch(() => null);
            if (read?.kind === 'ok') queryClient.setQueryData(chatKeys.detail(chat.id), read.data);
            void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
        })();
    }, [engineApi, queryClient, chat.id, unread]);

    const reportedSeen = useRef(new Set<string>());
    const markSeen = useCallback(
        (messageIds: readonly string[]) => {
            const fresh = messageIds.filter((id) => !reportedSeen.current.has(id));
            if (fresh.length === 0) return;
            for (const id of fresh) reportedSeen.current.add(id);
            void (async () => {
                const seen = await engineApi.chats
                    .markSeen(
                        chat.id,
                        { messageIds: fresh.map((id) => MessageId.parse(id)) },
                        AbortSignal.timeout(10_000),
                    )
                    .catch(() => null);
                if (seen?.kind === 'ok') queryClient.setQueryData(chatKeys.detail(chat.id), seen.data);
            })();
        },
        [engineApi, queryClient, chat.id],
    );
    const answer = useCallback(
        (messageId: string, choice: string) => {
            void session.send(choice, MessageId.parse(messageId));
        },
        [session],
    );
    const active = isReplyActive(session.state.phase);
    const { completedCount } = session.state;
    // Once per finished reply, never per token; the trailing space makes a repeat count as a change.
    const finished =
        completedCount === 0
            ? ''
            : `${m.chat_reply_finished({ name: mainName })}${completedCount % 2 === 0 ? ' ' : ''}`;
    const announcement = session.state.phase === 'unconfirmed' ? m.chat_send_unconfirmed() : finished;

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
                virtual={chat.messageCount > VIRTUALIZE_ABOVE}
                hasOlder={history.hasNextPage}
                loadingOlder={history.isFetchingNextPage}
                onLoadOlder={() => {
                    void history.fetchNextPage();
                }}
                onRetry={session.retry}
                onSeen={markSeen}
                {...(canWrite ? { onAnswer: answer } : {})}
                onJumpedToLatest={() => {
                    textareaRef.current?.focus();
                }}
            />
        );
    }

    return (
        <div ref={panelRef} className={cx('flex flex-col', fill ? 'min-h-0 flex-1' : 'h-[70dvh] min-h-96')}>
            <ThreadReferencesProvider value={references}>{body}</ThreadReferencesProvider>
            <div aria-live="polite" aria-atomic="true" className="sr-only">
                {announcement}
            </div>
            {canWrite ? (
                // Floats over the thread's faded last lines (message-list.tsx leaves room for it).
                <Composer
                    label={m.chat_composer_label()}
                    labelHidden
                    placeholder={m.chat_composer_placeholder({ name: agentName })}
                    busy={active}
                    sendPaused={session.state.phase === 'unconfirmed'}
                    {...(session.state.phase === 'streaming'
                        ? { stop: 'ready' as const }
                        : session.state.phase === 'stopping'
                          ? { stop: 'stopping' as const }
                          : {})}
                    onSend={(content) => session.send(content)}
                    onStop={stop}
                    mentionables={mentionables}
                    addressee={addressee}
                    onAddresseeChange={setAddressee}
                    textareaRef={textareaRef}
                    className="relative z-10 mx-auto -mt-6 w-full max-w-3xl px-1 pb-1"
                />
            ) : null}
        </div>
    );
}
