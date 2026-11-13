import { Button } from '@ptbk/ui';
import { createContext, use, useId, useState } from 'react';
import type { ReactNode } from 'react';

import { useNow } from '../../app/ticker';
import { m } from '../../paraglide/messages';
import type { RecheckView, WaitingView } from './message-views';
import { tintStyle } from './references/agent-color';
import { formatClock } from './references/elapsed';
import { StatusDot } from './references/task-status';
import { useReferenceAgent } from './references/thread-references';
import { Fold, FoldChevron } from './steps-card';
import { useShortTime } from './thread-time';

/** After this long without a sign of the agent, "starting" becomes "still waiting". */
export const STILL_WAITING_MS = 20_000;
/** After this long, waiting becomes an error with Retry. */
export const NO_RESPONSE_MS = 120_000;

/** Asks the engine to attempt the thread's reply again, then refreshes the thread; resolves when that is done. */
export type RetryReply = () => Promise<void>;

const RetryReplyContext = createContext<RetryReply | null>(null);

/** The panel's way to retry a reply, for rows deep in the list; a list without it (a test chat) offers no Retry. */
export function RetryReplyProvider({ retry, children }: { readonly retry: RetryReply; readonly children: ReactNode }) {
    return <RetryReplyContext value={retry}>{children}</RetryReplyContext>;
}

function useRetryAction(): { readonly run: (() => void) | null; readonly busy: boolean } {
    const retry = use(RetryReplyContext);
    const [busy, setBusy] = useState(false);
    if (retry === null) return { run: null, busy };
    return {
        busy,
        run: () => {
            setBusy(true);
            void retry().finally(() => {
                setBusy(false);
            });
        },
    };
}

function Details({ children }: { readonly children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const id = useId();
    return (
        <div className="flex flex-col gap-1">
            <button
                type="button"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => {
                    setOpen(!open);
                }}
                className="-mx-1 flex w-fit items-center gap-1 rounded-small px-1 text-xs text-text-muted hover:text-text"
            >
                {m.chat_wait_details()}
                <FoldChevron open={open} />
            </button>
            <Fold id={id} open={open}>
                <p className="text-xs text-text-muted">{children}</p>
            </Fold>
        </div>
    );
}

const ERROR_SURFACE = 'flex w-full max-w-xl flex-col gap-2 px-3.5 py-2.5 soft-surface [--tint:var(--color-danger)]';

/**
 * The member's message is in and nobody has started on it. Quiet at first ("Chatter is starting…"), then "Still
 * waiting" after 20 s, and after 2 min an error with Retry. It disappears the moment the agent starts working.
 */
export function WaitingCard({ view }: { readonly view: WaitingView }) {
    const now = useNow();
    const retry = useRetryAction();
    const agent = useReferenceAgent(view.agent.key, view.agentName);
    // Retry restarts the wait: the engine gets another two minutes before this turns into an error again.
    const [restartedAt, setRestartedAt] = useState<number | null>(null);
    const arrivedAt = useShortTime(view.since);
    const waited = now - (restartedAt ?? Date.parse(view.since));

    if (waited < NO_RESPONSE_MS) {
        const still = waited >= STILL_WAITING_MS;
        return (
            <p
                role="status"
                className="flex items-center gap-2 py-1 text-sm text-text-muted motion-safe:animate-fade-in"
                style={tintStyle(agent.color)}
            >
                {still ? (
                    <StatusDot tone="waiting" />
                ) : (
                    <span aria-hidden="true" className="size-2 rounded-full bg-tint motion-safe:animate-breathe" />
                )}
                {still ? m.chat_wait_still({ name: agent.name }) : m.chat_wait_starting({ name: agent.name })}
            </p>
        );
    }
    return (
        <section role="alert" aria-label={m.chat_wait_failed({ name: agent.name })} className={ERROR_SURFACE}>
            <div className="flex flex-wrap items-center gap-2">
                <StatusDot tone="trouble" />
                <span className="text-sm font-medium">{m.chat_wait_failed({ name: agent.name })}</span>
                {retry.run === null ? null : (
                    <Button
                        size="sm"
                        className="ms-auto"
                        disabled={retry.busy}
                        onClick={() => {
                            setRestartedAt(now);
                            retry.run?.();
                        }}
                    >
                        {m.chat_reply_retry()}
                    </Button>
                )}
            </div>
            <Details>{m.chat_wait_details_text({ time: arrivedAt })}</Details>
        </section>
    );
}

/**
 * A failed reply the engine will attempt again by itself: its cause, a live countdown to the next attempt and Retry
 * now. The cause is engine text: rendered as text only.
 */
export function RecheckCard({ view }: { readonly view: RecheckView }) {
    const now = useNow();
    const retry = useRetryAction();
    const left = Date.parse(view.nextAt) - now;
    const title =
        view.agentName === null ? m.chat_recheck_title_unnamed() : m.chat_recheck_title({ name: view.agentName });
    return (
        // Not a live region: the countdown would be read out every second.
        <section aria-label={title} className={ERROR_SURFACE}>
            <div className="flex items-center gap-2">
                <StatusDot tone="trouble" />
                <span className="text-sm font-medium">{title}</span>
            </div>
            <p className="text-sm break-words text-text-muted">{view.cause}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="meta">
                    {left > 0 ? m.chat_recheck_countdown({ time: formatClock(left) }) : m.chat_recheck_now()}
                </span>
                {retry.run === null ? null : (
                    <Button size="sm" className="ms-auto" disabled={retry.busy} onClick={retry.run}>
                        {m.chat_recheck_retry_now()}
                    </Button>
                )}
            </div>
        </section>
    );
}
