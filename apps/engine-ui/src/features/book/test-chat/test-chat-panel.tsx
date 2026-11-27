import type { AgentId, Diagnostic } from '@ptbk/engine-api';
import { Banner, Button, StatusPill } from '@ptbk/ui';
import { RotateCcw } from 'lucide-react';
import { useEffect, useId, useMemo, useRef } from 'react';

import { cx } from '../../../app/cx';
import { m } from '../../../paraglide/messages';
import { LookedUpAgentAvatar } from '../../agents/looked-up-agent-avatar';
import { Composer } from '../../chat/composer';
import { MessageList } from '../../chat/message-list';
import { useCurrentMember } from '../../session/use-current-member';
import type { TestChatError } from './test-chat-session';
import { testChatViews } from './test-chat-views';
import { useTestChat } from './use-test-chat';

const ERROR_MESSAGES: Readonly<Record<TestChatError, () => string>> = {
    'invalid-book': m.book_test_invalid_book,
    'too-large': m.book_test_too_large,
    limit: m.book_test_limit,
    forbidden: m.book_test_forbidden,
    'rate-limited': m.book_test_rate_limited,
    'agent-deleted': m.book_test_agent_deleted,
    'reply-failed': m.book_test_reply_failed,
    dropped: m.book_test_dropped,
    failed: m.book_test_failed,
};

/** Sending the same conversation again can work after these; the others need the member to change something first. */
const RETRYABLE: ReadonlySet<TestChatError> = new Set([
    'invalid-book',
    'rate-limited',
    'reply-failed',
    'dropped',
    'failed',
]);

export interface TestChatPanelProps {
    readonly agentId: AgentId;
    /** The book as typed, saved or not; every turn tests this text. */
    readonly book: string;
    /** The name the draft gives the agent, for the rows and the placeholder. */
    readonly agentName: string;
    /** The engine found errors in the draft: show them in the editor's problems list. */
    readonly onInvalidBook: (diagnostics: readonly Diagnostic[]) => void;
    readonly onShowProblems: () => void;
    /** 2 where the panel is a top-level section of its page (the Book tab). */
    readonly headingLevel?: 2 | 3;
    /** The hint above the composer; the book editor's default speaks of unsaved changes. */
    readonly intro?: string;
    readonly className?: string;
}

/**
 * The book editor's live test chat: a conversation with the unsaved draft that the engine never stores. It reuses the
 * chat's rows and composer, so agent output is rendered exactly as safely as in a real chat.
 */
export function TestChatPanel({
    agentId,
    book,
    agentName,
    onInvalidBook,
    onShowProblems,
    headingLevel = 3,
    intro = m.book_test_intro(),
    className,
}: TestChatPanelProps) {
    const Heading = headingLevel === 2 ? 'h2' : 'h3';
    const headingId = useId();
    const me = useCurrentMember();
    const chat = useTestChat({ agentId, book, onInvalidBook });
    const { state } = chat;
    const views = useMemo(() => testChatViews(state, me.memberId, agentName), [state, me.memberId, agentName]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const streaming = state.phase === 'streaming';
    // Once per finished reply, never per token; the trailing space makes a repeat count as a change.
    const announcement =
        state.completedCount === 0
            ? ''
            : `${m.chat_reply_finished({ name: agentName })}${state.completedCount % 2 === 0 ? ' ' : ''}`;

    const stop = () => {
        chat.stop();
        textareaRef.current?.focus();
    };

    const panelRef = useRef<HTMLElement>(null);
    const stopOnEscape = useRef<(event: KeyboardEvent) => void>(() => undefined);
    useEffect(() => {
        stopOnEscape.current = (event) => {
            if (event.key !== 'Escape' || !streaming) return;
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

    const error = state.error;
    const retryable = error !== null && state.phase === 'error' && RETRYABLE.has(error);
    const actions =
        error === 'invalid-book' || retryable ? (
            <div className="flex flex-wrap gap-2">
                {error === 'invalid-book' ? (
                    <Button size="sm" onClick={onShowProblems}>
                        {m.book_test_show_problems()}
                    </Button>
                ) : null}
                {retryable ? (
                    <Button size="sm" onClick={chat.retry}>
                        {m.error_retry()}
                    </Button>
                ) : null}
            </div>
        ) : null;

    return (
        <section
            ref={panelRef}
            aria-labelledby={headingId}
            className={cx('flex min-h-0 min-w-0 flex-col gap-3', className)}
            data-testid="book-test-chat"
        >
            <header className="flex min-h-8 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Heading id={headingId} className="text-sm font-semibold">
                        {m.book_test_title()}
                    </Heading>
                    <StatusPill tone="waiting" variant="quiet">
                        {m.book_test_badge()}
                    </StatusPill>
                </div>
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={views.length === 0 && error === null}
                    onClick={() => {
                        chat.reset();
                        textareaRef.current?.focus();
                    }}
                >
                    <RotateCcw aria-hidden className="size-4" />
                    {m.book_test_reset()}
                </Button>
            </header>
            {views.length === 0 ? (
                // Like a fresh chat: the agent waits in the middle, and the hint sits above the composer it is about.
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
                    <LookedUpAgentAvatar agentKey={agentId} name={agentName} size="lg" />
                    <p className="max-w-xs text-sm text-text-muted">{intro}</p>
                </div>
            ) : (
                <MessageList
                    label={m.book_test_messages()}
                    views={views}
                    virtual={false}
                    hasOlder={false}
                    loadingOlder={false}
                    onLoadOlder={() => undefined}
                    onRetry={chat.retry}
                    onJumpedToLatest={() => {
                        textareaRef.current?.focus();
                    }}
                />
            )}
            {error === null ? null : (
                <Banner tone="danger" {...(actions === null ? {} : { action: actions })}>
                    {ERROR_MESSAGES[error]()}
                </Banner>
            )}
            <div aria-live="polite" aria-atomic="true" className="sr-only">
                {announcement}
            </div>
            <Composer
                label={m.chat_composer_label()}
                labelHidden
                placeholder={m.book_test_placeholder({ name: agentName })}
                busy={streaming}
                {...(streaming ? { stop: 'ready' as const } : {})}
                onSend={chat.send}
                onStop={stop}
                textareaRef={textareaRef}
            />
        </section>
    );
}
