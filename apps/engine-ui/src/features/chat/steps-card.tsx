import type { ReadReplyStep } from '@ptbk/engine-api';
import { useLocale } from '@ptbk/ui';
import type { Formatters } from '@ptbk/ui';
import { Check, ChevronRight, CircleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import type { StepsView } from './message-views';
import { StepLine } from './references/agent-hovercard';
import { formatClock, useElapsedMs } from './references/elapsed';
import { StatusDot } from './references/task-status';
import type { ChatTaskTone } from './references/task-status';

/** Counts up from `since` on the app's shared clock, as a mono stopwatch. */
export function Elapsed({ since }: { readonly since: string }) {
    const elapsed = useElapsedMs(since);
    return <span className="meta">{elapsed === null ? null : formatClock(elapsed)}</span>;
}

/**
 * A part that folds away: the grid row animates from `0fr` to its content's height, and while closed the content is
 * inert, so nothing hidden in it takes focus.
 */
export function Fold({
    id,
    open,
    children,
}: {
    readonly id: string;
    readonly open: boolean;
    readonly children: ReactNode;
}) {
    return (
        <div
            id={id}
            data-open={open ? '' : undefined}
            className="grid grid-rows-[0fr] data-open:grid-rows-[1fr] motion-safe:transition-[grid-template-rows] motion-safe:duration-(--motion-enter) motion-safe:ease-enter"
        >
            <div inert={!open} className="min-h-0 overflow-hidden">
                {children}
            </div>
        </div>
    );
}

export function FoldChevron({ open }: { readonly open: boolean }) {
    return (
        <ChevronRight
            aria-hidden
            data-open={open ? '' : undefined}
            className="size-3.5 data-open:rotate-90 motion-safe:transition-transform motion-safe:duration-(--motion-state)"
        />
    );
}

function Step({ step, current }: { readonly step: ReadReplyStep; readonly current: boolean }) {
    return (
        <li className="flex min-w-0 items-center gap-2 py-0.5 motion-safe:animate-rise-in">
            <span className="flex size-3.5 shrink-0 items-center justify-center">
                {current ? (
                    <StatusDot tone="live" />
                ) : step.level === 'error' || step.level === 'warning' ? (
                    <CircleAlert
                        aria-hidden
                        className={cx('size-3.5', step.level === 'error' ? 'text-danger' : 'text-warning')}
                    />
                ) : (
                    <Check aria-hidden className="size-3.5 text-text-muted" />
                )}
                <span className="sr-only">{current ? m.chat_step_current() : m.chat_step_done()}</span>
            </span>
            <span className="min-w-0 flex-1">
                {step.kind === 'reasoning' && step.text.trim() === '' ? (
                    <span className="block text-xs text-text-muted italic">{m.chat_step_reasoning()}</span>
                ) : (
                    <StepLine step={step} />
                )}
            </span>
        </li>
    );
}

/** A turn that just stopped is quiet, like a cancelled task; one whose last step went wrong is trouble. */
export function unfinishedTone(steps: readonly ReadReplyStep[]): ChatTaskTone {
    return steps.at(-1)?.level === 'error' ? 'trouble' : 'quiet';
}

/** "1 step", "3 kroky", "5 kroků": plural forms by the language's own rules. */
function stepCountText(count: number, locale: Formatters): string {
    const value = locale.formatNumber(count);
    switch (new Intl.PluralRules(locale.locale).select(count)) {
        case 'one':
            return m.chat_steps_count_one();
        case 'few':
            return m.chat_steps_count_few({ count: value });
        case 'zero':
        case 'two':
        case 'many':
        case 'other':
            return m.chat_steps_count({ count: value });
    }
}

/**
 * One agent turn's steps. Live, it ticks through them with an elapsed timer; once a reply ends the turn it folds into
 * "Worked 8 s · 3 steps", which opens again on click; a turn that ended without a reply stays open. Step text is agent
 * output: text nodes only, and nothing in the card is a link or a control except its own toggle.
 */
export function StepsCard({ view }: { readonly view: StepsView }) {
    const locale = useLocale();
    const listId = useId();
    const [chosen, setChosen] = useState<boolean | null>(null);
    const live = view.status === 'live';
    const open = live || (chosen ?? view.status === 'unfinished');
    const count = view.steps.length;
    const stepCount = stepCountText(count, locale);
    const elapsed = view.endedAt === null ? 0 : Date.parse(view.endedAt) - Date.parse(view.startedAt);
    // An engine that saves its progress only with the reply gives no real duration; better none than "0 s".
    const summary =
        view.status === 'unfinished'
            ? m.chat_steps_unfinished()
            : elapsed < 1000
              ? m.chat_steps_worked_brief({ steps: stepCount })
              : m.chat_steps_worked({ duration: locale.formatDuration(elapsed), steps: stepCount });

    return (
        <section
            aria-label={live ? m.chat_steps_working() : summary}
            aria-busy={live || undefined}
            className={cx(
                'w-full max-w-xl rounded-surface px-3 motion-safe:transition-[background-color,padding] motion-safe:duration-(--motion-enter) motion-safe:ease-enter',
                open ? 'soft-surface py-2' : 'py-0.5',
                live && 'motion-safe:animate-rise-in',
            )}
        >
            {live ? (
                <div className="flex items-center gap-2 text-sm">
                    <span aria-hidden="true" className="size-2 rounded-full bg-tint motion-safe:animate-breathe" />
                    <span className="font-medium">{m.chat_steps_working()}</span>
                    <Elapsed since={view.startedAt} />
                </div>
            ) : (
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={listId}
                    onClick={() => {
                        setChosen(!open);
                    }}
                    className="-mx-1 flex items-center gap-1.5 rounded-small px-1 meta hover:text-text"
                >
                    {view.status === 'unfinished' ? <StatusDot tone={unfinishedTone(view.steps)} /> : null}
                    <span>{view.status === 'unfinished' ? `${summary} · ${stepCount}` : summary}</span>
                    <FoldChevron open={open} />
                </button>
            )}
            <Fold id={listId} open={open}>
                <div className="pt-1.5">
                    {count === 0 ? (
                        <p className="py-0.5 text-sm text-text-muted">{live ? m.chat_steps_starting() : null}</p>
                    ) : (
                        <ol aria-label={m.chat_steps_label()} className="flex flex-col">
                            {view.steps.map((step, index) => (
                                // Steps only grow at the end, so a position is a stable identity: only new ones slide in.
                                <Step key={index} step={step} current={live && index === count - 1} />
                            ))}
                        </ol>
                    )}
                </div>
            </Fold>
        </section>
    );
}
