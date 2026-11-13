import type { ReadChat } from '@ptbk/engine-api';
import { RelativeTime, Section, Skeleton, StatusDot } from '@ptbk/ui';
import { MessageSquare } from 'lucide-react';

import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { chatName } from '../chat/thread-list';
import { plainText } from './question-text';
import { useAgentLook } from './use-agent-look';

export const RECENT_CHAT_COUNT = 6;
const AVATARS = 3;

function MemberAvatar({ agentKey, name }: { readonly agentKey: string; readonly name: string }) {
    const look = useAgentLook(agentKey);
    return (
        <AgentAvatar name={name} agentKey={agentKey} profile={look.profile} size="xs" className="ring-2 ring-surface" />
    );
}

/** The thread's agents as overlapping avatars, first joined first; people are implied. */
function ChatAvatars({ chat }: { readonly chat: ReadChat }) {
    const agents = chat.members.filter((member) => member.kind === 'agent').slice(0, AVATARS);
    if (agents.length === 0) {
        return (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-neutral-soft text-text-muted">
                <MessageSquare aria-hidden className="size-3.5" />
            </span>
        );
    }
    return (
        <span className="flex w-10 shrink-0 -space-x-2">
            {agents.map((agent) => (
                <MemberAvatar key={agent.key} agentKey={agent.key} name={agent.name} />
            ))}
        </span>
    );
}

function ChatRow({ chat }: { readonly chat: ReadChat }) {
    const waiting = chat.questions.length > 0;
    const unread = chat.unread > 0;
    return (
        <li>
            <Link
                to="/chats/$chatId"
                params={{ chatId: chat.id }}
                variant="standalone"
                className="-mx-2 flex min-h-12 items-center gap-3 rounded-control px-2 py-2 text-text no-underline hover:bg-hover hover:no-underline"
            >
                <ChatAvatars chat={chat} />
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{chatName(chat)}</span>
                        {waiting ? (
                            <StatusDot tone="warning" label={m.chat_needs_you()} />
                        ) : unread ? (
                            <StatusDot tone="info" label={m.chat_unread({ count: chat.unread })} />
                        ) : null}
                    </span>
                    {chat.preview === null ? null : (
                        <span className="truncate text-xs text-text-muted">{plainText(chat.preview)}</span>
                    )}
                </span>
                <RelativeTime
                    value={new Date(chat.lastMessageAt ?? chat.updatedAt)}
                    className="shrink-0 text-xs text-text-muted tabular-nums"
                />
            </Link>
        </li>
    );
}

/** The newest threads, with who is in them and their latest words; one quiet line before the first. */
export function RecentChats({
    chats,
    failed,
}: {
    readonly chats: readonly ReadChat[] | undefined;
    readonly failed: boolean;
}) {
    return (
        <Section
            title={m.home_recent_chats()}
            actions={
                <Link to="/chats" variant="standalone" className="text-xs text-text-muted">
                    {m.home_all_chats()}
                </Link>
            }
        >
            {chats === undefined ? (
                failed ? (
                    <p className="text-sm text-text-muted">{m.home_widget_failed()}</p>
                ) : (
                    <div aria-busy="true" className="flex flex-col gap-2">
                        {[0, 1, 2].map((row) => (
                            <Skeleton key={row} className="h-10 w-full" />
                        ))}
                    </div>
                )
            ) : chats.length === 0 ? (
                <p className="text-sm text-text-muted">{m.home_recent_chats_empty_body()}</p>
            ) : (
                <ul className="flex flex-col">
                    {chats.slice(0, RECENT_CHAT_COUNT).map((chat) => (
                        <ChatRow key={chat.id} chat={chat} />
                    ))}
                </ul>
            )}
        </Section>
    );
}
