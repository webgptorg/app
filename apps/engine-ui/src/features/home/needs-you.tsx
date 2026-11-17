import type { ReadChat, ReadTask } from '@ptbk/engine-api';
import { EmptyState, Section, Skeleton, STATUS_TINT_CLASSES } from '@ptbk/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, MessageCircleQuestion } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import type { Attention, FeatureDefinition } from '../../app/registry/feature';
import { useVisibleFeatures } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { chatEntriesQueryOptions } from '../chat/chat-queries';
import { tintStyle } from '../chat/references/agent-color';
import { chatName } from '../chat/chat-name';
import { EntityChip } from '../entities/entity-chip';
import { questionQuote } from './question-text';
import { useAgentLook } from './use-agent-look';
import { useHomeTasks } from './use-home-tasks';

/** One thing waiting on the member: who or what, in a sentence, and the one action that answers it. */
function NeedsYouItem({
    leading,
    tint,
    tintClassName,
    title,
    children,
    action,
}: {
    readonly leading: ReactNode;
    /** An agent's colour (CSSOM `--tint`), for its questions. */
    readonly tint?: string | undefined;
    /** A state's `--tint` class, for everything else. */
    readonly tintClassName?: string | undefined;
    readonly title: ReactNode;
    readonly children?: ReactNode;
    readonly action: ReactNode;
}) {
    return (
        <li
            className={cx('soft-surface flex items-start gap-3 px-4 py-3', tintClassName)}
            style={tint === undefined ? undefined : tintStyle(tint)}
        >
            <span className="mt-0.5 flex shrink-0 [&>svg]:size-5 [&>svg]:text-tint">{leading}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm font-medium [overflow-wrap:anywhere]">{title}</span>
                {children}
            </span>
            <span className="flex shrink-0 items-center self-center">{action}</span>
        </li>
    );
}

/** The question's own words, from the thread's newest entries (the cache the thread itself reads). */
function QuestionQuote({ chat, messageId }: { readonly chat: ReadChat; readonly messageId: string }) {
    const entries = useInfiniteQuery(chatEntriesQueryOptions(useEngineApi(), chat.id));
    if (entries.isPending) return <Skeleton className="h-4 w-2/3" />;
    const message = entries.data?.pages
        .flatMap((page) => page.items)
        .find((entry) => entry.type === 'message' && entry.id === messageId);
    const quote = message?.type === 'message' ? questionQuote(message.content) : '';
    if (quote === '') return null;
    // Agent words: a text node, never markup.
    return <q className="line-clamp-2 text-sm text-text-muted [overflow-wrap:anywhere]">{quote}</q>;
}

function QuestionItem({ chat }: { readonly chat: ReadChat }) {
    const question = chat.questions[0];
    const author = chat.members.find(
        (member) => member.kind === question?.author.kind && member.key === question.author.key,
    );
    const name = author?.name ?? question?.author.key ?? '';
    const look = useAgentLook(question?.author.key ?? '');
    if (question === undefined) return null;
    return (
        <NeedsYouItem
            tint={look.color}
            leading={
                <AgentAvatar
                    name={name}
                    agentKey={question.author.key}
                    profile={look.profile}
                    origin={look.origin}
                    size="xs"
                />
            }
            title={
                <>
                    <span>{m.home_asks_you({ name })}</span>
                    <span className="ms-1.5 font-normal text-text-muted">{chatName(chat)}</span>
                </>
            }
            action={
                <ButtonLink to="/chats/$chatId" params={{ chatId: chat.id }} size="sm">
                    {m.home_reply()}
                </ButtonLink>
            }
        >
            <QuestionQuote chat={chat} messageId={question.messageId} />
        </NeedsYouItem>
    );
}

function TaskItem({ task }: { readonly task: ReadTask }) {
    return (
        <NeedsYouItem
            tintClassName={STATUS_TINT_CLASSES.warning}
            leading={<MessageCircleQuestion aria-hidden />}
            title={<EntityChip kind="task" id={task.id} name={task.name} />}
            action={
                <ButtonLink to="/tasks/$taskId" params={{ taskId: task.id }} size="sm">
                    {m.home_open()}
                </ButtonLink>
            }
        >
            {task.stateReason === null ? null : (
                <span className="line-clamp-2 text-sm text-text-muted [overflow-wrap:anywhere]">
                    {task.stateReason}
                </span>
            )}
        </NeedsYouItem>
    );
}

type AttentionEntry = NonNullable<FeatureDefinition['attention']>;

/** Calls one provider's hook; one component per provider keeps the rules of hooks with any number of them. */
function AttentionProbe({
    entry,
    onAttention,
}: {
    readonly entry: AttentionEntry;
    readonly onAttention: (id: string, attention: Attention) => void;
}) {
    const attention = entry.useAttention();
    useEffect(() => {
        onAttention(entry.id, attention);
    }, [entry.id, attention, onAttention]);
    return null;
}

/**
 * Every registered provider's count (failed runs, logins agents wait for, people asking to join…) as one line each
 * with a way to the view that shows exactly what it counts.
 */
function useAttentionItems() {
    const sources = useVisibleFeatures().flatMap((feature) =>
        feature.attention === undefined ? [] : [{ feature, entry: feature.attention }],
    );
    const [reported, setReported] = useState<ReadonlyMap<string, Attention>>(new Map());
    const [onAttention] = useState(() => (id: string, attention: Attention) => {
        setReported((previous) => {
            const known = previous.get(id);
            return known?.count === attention.count && known.pending === attention.pending && known.to === attention.to
                ? previous
                : new Map(previous).set(id, attention);
        });
    });
    const probes = sources.map(({ entry }) => (
        <AttentionProbe key={entry.id} entry={entry} onAttention={onAttention} />
    ));
    const items = sources.flatMap(({ feature, entry }) => {
        const attention = reported.get(entry.id);
        if (attention === undefined || attention.count === 0) return [];
        const label =
            entry.label?.(attention.count) ?? `${feature.nav?.label() ?? feature.id}: ${String(attention.count)}`;
        return [{ id: entry.id, label, attention, tone: entry.tone ?? 'warning' }];
    });
    const pending = sources.some(({ entry }) => {
        const attention = reported.get(entry.id);
        return attention === undefined || attention.pending === true;
    });
    return { probes, items, pending };
}

/**
 * What waits on the member, loudest first: agents' questions, tasks waiting on them, then everything a feature
 * counts. Each item sits on a soft surface with one action. When nothing waits, the section is one quiet line.
 */
export function NeedsYou({ chats }: { readonly chats: readonly ReadChat[] | undefined }) {
    const { tasks } = useHomeTasks('awaiting-user');
    const waitingTasks = tasks ?? [];
    const asking = (chats ?? []).filter((chat) => chat.questions.length > 0);
    const { probes, items, pending } = useAttentionItems();
    const loading = chats === undefined || tasks === undefined || pending;
    const empty = asking.length === 0 && waitingTasks.length === 0 && items.length === 0;
    return (
        <Section
            title={m.home_needs_you()}
            {...(empty ? {} : { count: asking.length + waitingTasks.length + items.length })}
        >
            {probes}
            {empty ? (
                loading ? (
                    <Skeleton shape="block" className="h-14 w-full" />
                ) : (
                    <EmptyState
                        variant="inline"
                        headingLevel={3}
                        icon={<CircleCheck aria-hidden />}
                        title={m.home_needs_you_empty()}
                    />
                )
            ) : (
                <ul className="flex flex-col gap-2">
                    {asking.map((chat) => (
                        <QuestionItem key={chat.id} chat={chat} />
                    ))}
                    {waitingTasks.map((task) => (
                        <TaskItem key={task.id} task={task} />
                    ))}
                    {items.length === 0 ? null : (
                        <li>
                            {/* Counts from features: one calm surface with a line each, not a stack of alerts. */}
                            <ul
                                className={cx(
                                    'soft-surface flex flex-col divide-y divide-hairline',
                                    STATUS_TINT_CLASSES.warning,
                                )}
                            >
                                {items.map(({ id, label, attention, tone }) => (
                                    <li key={id} className="flex items-center gap-3 px-4 py-2.5">
                                        <CircleAlert
                                            aria-hidden
                                            className={cx(
                                                'size-4 shrink-0',
                                                tone === 'danger' ? 'text-danger' : 'text-warning',
                                            )}
                                        />
                                        <span className="min-w-0 flex-1 text-sm font-medium">{label}</span>
                                        <ButtonLink
                                            to={attention.to}
                                            search={attention.search ?? {}}
                                            size="sm"
                                            variant="ghost"
                                        >
                                            {m.home_review()}
                                        </ButtonLink>
                                    </li>
                                ))}
                            </ul>
                        </li>
                    )}
                </ul>
            )}
        </Section>
    );
}
