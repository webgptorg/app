import { Badge, Button, Spinner } from '@ptbk/ui';
import { useState } from 'react';
import type { ReactNode, Ref } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { AgentCreator } from '../agents/agent-creator';
import type { MessageState, MessageView, StepsView, ThreadView } from './message-views';
import { MessageMarkdown } from './render/lazy-markdown';
import { PlainText } from './render/plain-text';
import { tintStyle } from './references/agent-color';
import { ReferenceAvatar } from './references/reference-avatar';
import { useReferenceAgent } from './references/thread-references';
import { RecheckCard, WaitingCard } from './reply-status-card';
import { StepsCard } from './steps-card';
import { TaskCard } from './task-card';
import { DayDivider, TurnTime } from './thread-time';

/** A row this recent arrived while the thread was open; older ones (a reload, scrolling back) appear without motion. */
const FRESH_MS = 15_000;

function useArrivedNow(at: string | null): boolean {
    const [fresh] = useState(() => at !== null && Date.now() - Date.parse(at) < FRESH_MS);
    return fresh;
}

function StateLabel({ state }: { readonly state: MessageState }) {
    switch (state) {
        case 'streaming':
            return (
                <span className="inline-flex items-center gap-1.5">
                    <Spinner size="sm" announce={false} />
                    {m.chat_status_streaming()}
                </span>
            );
        case 'stopped':
            return <Badge>{m.chat_status_stopped()}</Badge>;
        case 'interrupted':
            return <Badge tone="warning">{m.chat_status_interrupted()}</Badge>;
        case 'failed':
            return <Badge tone="danger">{m.chat_status_failed()}</Badge>;
        case 'unconfirmed':
            return <Badge tone="warning">{m.chat_send_unconfirmed()}</Badge>;
        case 'pending':
        case null:
            return null;
    }
}

function Author({ view }: { readonly view: MessageView }) {
    if (view.author.kind !== 'user') return <span>{view.authorName}</span>;
    if (view.createdBy === null) return <span>{m.chat_user()}</span>;
    return <AgentCreator memberId={view.createdBy} />;
}

/** The dots a reply shows before its first words arrive. */
function Typing() {
    return (
        <span aria-hidden="true" className="inline-flex h-7 items-center gap-1">
            {[0, 1, 2].map((dot) => (
                <span
                    key={dot}
                    className={cx(
                        'size-1.5 rounded-full bg-text-muted motion-safe:animate-pulse',
                        dot === 1 && 'motion-safe:[animation-delay:150ms]',
                        dot === 2 && 'motion-safe:[animation-delay:300ms]',
                    )}
                />
            ))}
        </span>
    );
}

/** Its offered answers as buttons while the question waits; a member who may not write sees them as nothing. */
function Choices({
    view,
    onAnswer,
}: {
    readonly view: MessageView;
    readonly onAnswer: ((messageId: string, choice: string) => void) | undefined;
}) {
    if (onAnswer === undefined || view.choices.length === 0) return null;
    return (
        <div className="flex flex-wrap items-center gap-2 pt-1">
            {view.choices.map((choice) => (
                <Button
                    key={choice}
                    size="sm"
                    onClick={() => {
                        onAnswer(view.id, choice);
                    }}
                >
                    {choice}
                </Button>
            ))}
        </div>
    );
}

/**
 * An agent's turn: its avatar, name in its colour and time on top, then its words or steps beside a thin rail in the
 * same colour. A row that continues the turn shows only the rail; screen readers still hear who speaks.
 */
function AgentTurn({
    view,
    showAuthor,
    at,
    children,
}: {
    readonly view: MessageView | StepsView;
    readonly showAuthor: boolean;
    readonly at: string | null;
    readonly children: ReactNode;
}) {
    const agent = useReferenceAgent(view.author.key, view.authorName);
    return (
        <div className="flex w-full min-w-0 flex-col items-start gap-1.5" style={tintStyle(agent.color)}>
            <header className={cx('flex items-center gap-2 text-sm font-medium', !showAuthor && 'sr-only')}>
                <ReferenceAvatar agent={agent} size="xs" />
                <span className="text-tint">{view.authorName}</span>
                {at === null ? null : <TurnTime at={at} />}
            </header>
            <div className="ms-3 flex w-[calc(100%-0.75rem)] min-w-0 flex-col gap-1.5 border-s-2 border-[color-mix(in_oklab,var(--tint)_40%,transparent)] ps-[1.125rem]">
                {children}
            </div>
        </div>
    );
}

export interface MessageRowProps {
    readonly view: ThreadView;
    /** The first message after someone else's; it gets more room above it. */
    readonly startsTurn: boolean;
    /** Who wrote it is shown, not only said to screen readers. */
    readonly showAuthor: boolean;
    readonly onRetry: () => void;
    /** Answers this row's question with one of its choices; absent for members who may not write. */
    readonly onAnswer?: ((messageId: string, choice: string) => void) | undefined;
    /** `data-index` for the virtualiser's measurement; absent when every row is mounted. */
    readonly index?: number;
    readonly ref?: Ref<HTMLElement>;
}

function MessageBody({
    view,
    startsTurn,
    showAuthor,
    onRetry,
    onAnswer,
    index,
    ref,
}: MessageRowProps & { readonly view: MessageView }) {
    const fresh = useArrivedNow(view.createdAt);
    const fromUser = view.author.kind === 'user';
    const author = <Author view={view} />;
    const status =
        view.state === null || view.state === 'pending' ? null : (
            <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
                <StateLabel state={view.state} />
                {view.retry ? (
                    <Button size="sm" onClick={onRetry}>
                        {view.state === 'unconfirmed' ? m.chat_send_check_again() : m.error_retry()}
                    </Button>
                ) : null}
            </div>
        );
    const text = view.markdown ? <MessageMarkdown source={view.text} /> : <PlainText text={view.text} />;
    const typing = view.state === 'streaming' && view.text === '';

    return (
        <article
            ref={ref}
            data-index={index}
            data-message-id={view.id}
            data-unseen-question={view.question?.seen === false ? '' : undefined}
            aria-busy={view.state === 'streaming' || view.state === 'pending' || undefined}
            className={cx(
                'flex min-w-0 flex-col gap-1.5',
                fromUser ? 'items-end' : 'items-start',
                startsTurn ? 'pt-5' : 'pt-1.5',
                (fresh || view.state === 'pending') && 'motion-safe:animate-rise-in',
            )}
        >
            {fromUser ? (
                <>
                    {showAuthor ? (
                        <header className="flex items-center gap-2 px-1 text-xs font-medium text-text-muted">
                            {author}
                            {view.createdAt === null ? null : <TurnTime at={view.createdAt} />}
                        </header>
                    ) : (
                        <>
                            <header className="sr-only">{author}</header>
                            {startsTurn && view.createdAt !== null ? (
                                <span className="px-1">
                                    <TurnTime at={view.createdAt} />
                                </span>
                            ) : null}
                        </>
                    )}
                    <div
                        className={cx(
                            'max-w-[85%] min-w-0 rounded-[1.25rem] rounded-ee-small bg-accent-soft px-4 py-2.5 sm:max-w-[75%]',
                            (view.state === 'pending' || view.state === 'unconfirmed') && 'opacity-70',
                        )}
                    >
                        {text}
                    </div>
                    {status}
                </>
            ) : (
                <AgentTurn view={view} showAuthor={showAuthor} at={view.createdAt}>
                    {view.question === null ? (
                        // Keyed so the first words fade in where the typing dots were.
                        <div
                            key={typing ? 'typing' : 'text'}
                            className={cx(
                                'w-full min-w-0',
                                !typing && view.state === 'streaming' && 'motion-safe:animate-fade-in',
                            )}
                        >
                            {typing ? <Typing /> : text}
                        </div>
                    ) : (
                        <div className="flex w-full min-w-0 flex-col gap-1.5 px-3.5 py-2.5 soft-surface">
                            <p className="flex items-center gap-2 text-xs font-medium">
                                <span
                                    aria-hidden="true"
                                    className={cx(
                                        'size-2 rounded-full bg-tint',
                                        !view.question.seen && 'motion-safe:animate-breathe',
                                    )}
                                />
                                <span className="text-tint">{m.chat_question_waiting()}</span>
                            </p>
                            <div className="min-w-0">{text}</div>
                            <Choices view={view} onAnswer={onAnswer} />
                        </div>
                    )}
                    {status}
                </AgentTurn>
            )}
        </article>
    );
}

function StepsRow({
    view,
    startsTurn,
    showAuthor,
    index,
    ref,
}: Pick<MessageRowProps, 'startsTurn' | 'showAuthor' | 'index' | 'ref'> & { readonly view: StepsView }) {
    return (
        <div
            ref={ref as Ref<HTMLDivElement> | undefined}
            data-index={index}
            className={cx('flex min-w-0 flex-col items-start gap-1.5', startsTurn ? 'pt-5' : 'pt-1.5')}
        >
            <AgentTurn view={view} showAuthor={showAuthor} at={view.startedAt}>
                <StepsCard view={view} />
            </AgentTurn>
        </div>
    );
}

function CardRow({
    at,
    index,
    ref,
    children,
}: {
    readonly at: string | null;
    readonly index: number | undefined;
    readonly ref: Ref<HTMLElement> | undefined;
    readonly children: ReactNode;
}) {
    const fresh = useArrivedNow(at);
    return (
        <div
            ref={ref as Ref<HTMLDivElement> | undefined}
            data-index={index}
            className={cx('flex min-w-0 flex-col items-start pt-3 ps-8', fresh && 'motion-safe:animate-rise-in')}
        >
            {children}
        </div>
    );
}

/**
 * One row of the thread. A join or a new title is one quiet line, a new day a divider. The member's own words sit in a
 * bubble on the right; an agent's turn reads as plain text under its avatar and name, like a document rather than a
 * card, with its steps folded above the reply. Tasks, errors and questions to the User sit on soft surfaces. Agent
 * output only ever reaches the DOM as text nodes.
 */
export function MessageRow(props: MessageRowProps) {
    const { view, index, ref } = props;
    switch (view.kind) {
        case 'event':
            return (
                <p
                    ref={ref as Ref<HTMLParagraphElement> | undefined}
                    data-index={index}
                    className="py-2 text-center text-xs break-words text-text-muted"
                >
                    {view.text}
                </p>
            );
        case 'day':
            return (
                <div ref={ref as Ref<HTMLDivElement> | undefined} data-index={index}>
                    <DayDivider at={view.at} />
                </div>
            );
        case 'steps':
            return <StepsRow {...props} view={view} />;
        case 'task':
            return (
                <CardRow at={view.createdAt} index={index} ref={ref}>
                    <TaskCard view={view} />
                </CardRow>
            );
        case 'waiting':
            return (
                <CardRow at={null} index={index} ref={ref}>
                    <WaitingCard view={view} />
                </CardRow>
            );
        case 'recheck':
            return (
                <CardRow at={null} index={index} ref={ref}>
                    <RecheckCard view={view} />
                </CardRow>
            );
        case 'message':
            return <MessageBody {...props} view={view} />;
    }
}
