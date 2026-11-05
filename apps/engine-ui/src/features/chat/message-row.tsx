import { Badge, Button, Spinner } from '@ptbk/ui';
import type { Ref } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { AgentCreator } from '../agents/agent-creator';
import type { MessageState, MessageView, ThreadView } from './message-views';
import { MessageMarkdown } from './render/lazy-markdown';
import { PlainText } from './render/plain-text';

const NO_PROFILE = { avatarUrl: null, color: null } as const;

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

/** What an agent asks the User: a quiet label, and its offered answers as buttons while it waits. */
function Question({
    view,
    onAnswer,
}: {
    readonly view: MessageView;
    readonly onAnswer: ((choice: string) => void) | undefined;
}) {
    if (view.question === null) return null;
    return (
        <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">{m.chat_question_waiting()}</Badge>
            {onAnswer === undefined
                ? null
                : view.choices.map((choice) => (
                      <Button
                          key={choice}
                          size="sm"
                          onClick={() => {
                              onAnswer(choice);
                          }}
                      >
                          {choice}
                      </Button>
                  ))}
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

/**
 * One entry. A join or a new title is one quiet line. The member's own words sit in a bubble on the right; an agent's
 * message reads as plain text under its avatar and name, like a document rather than a card. Agent output only ever
 * reaches the DOM as text nodes.
 */
export function MessageRow({ view, startsTurn, showAuthor, onRetry, onAnswer, index, ref }: MessageRowProps) {
    if (view.kind === 'event') {
        return (
            <p
                ref={ref as Ref<HTMLParagraphElement> | undefined}
                data-index={index}
                className="py-2 text-center text-xs break-words text-text-muted"
            >
                {view.text}
            </p>
        );
    }
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
            )}
        >
            {fromUser ? (
                <>
                    {showAuthor ? (
                        <header className="px-1 text-xs font-medium text-text-muted">{author}</header>
                    ) : (
                        <header className="sr-only">{author}</header>
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
                <>
                    <header className={cx('flex items-center gap-2 text-sm font-medium', !showAuthor && 'sr-only')}>
                        <AgentAvatar name={view.authorName} profile={NO_PROFILE} size="xs" />
                        {author}
                    </header>
                    <div className="w-full min-w-0">
                        {view.state === 'streaming' && view.text === '' ? <Typing /> : text}
                    </div>
                    <Question
                        view={view}
                        onAnswer={
                            onAnswer === undefined
                                ? undefined
                                : (choice) => {
                                      onAnswer(view.id, choice);
                                  }
                        }
                    />
                    {status}
                </>
            )}
        </article>
    );
}
