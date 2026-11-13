import type { ReadReplyStep } from '@ptbk/engine-api';
import { useLocale } from '@ptbk/ui';
import { Check, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';

import { cx } from '../../app/cx';
import { useNow } from '../../app/ticker';
import { m } from '../../paraglide/messages';
import type { StepsView } from './message-views';

/** `0:08`, `12:40`, `1:02:03`: a running clock, mono, for timers and countdowns. */
export function clockText(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');
    return hours > 0
        ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${seconds}`
        : `${String(minutes)}:${seconds}`;
}

/** Counts up from `since` on the app's shared clock. */
export function Elapsed({ since }: { readonly since: string }) {
    const now = useNow();
    return <span className="font-mono text-xs text-text-muted tabular-nums">{clockText(now - Date.parse(since))}</span>;
}

function StepLine({ step, current }: { readonly step: ReadReplyStep; readonly current: boolean }) {
    const warn = step.level === 'warning' || step.level === 'error';
    return (
        <li className="chat-enter flex min-w-0 items-baseline gap-2 py-0.5 text-sm">
            <span className="flex size-3.5 shrink-0 items-center justify-center self-center">
                {current ? (
                    <span className="chat-dot" data-tone="live" data-pulse="" />
                ) : (
                    <Check aria-hidden className="size-3.5 text-text-muted" />
                )}
                <span className="sr-only">{current ? m.chat_step_current() : m.chat_step_done()}</span>
            </span>
            {step.kind === 'tool' && step.tool !== null ? (
                <>
                    <span className="shrink-0 font-mono text-xs font-semibold">{step.tool}</span>
                    <span className="min-w-0 truncate font-mono text-xs text-text-muted" title={step.text}>
                        {step.text}
                    </span>
                </>
            ) : (
                <>
                    <span className={cx('shrink-0 text-xs font-medium', warn ? 'text-warning' : 'text-text-muted')}>
                        {step.kind === 'reasoning' ? m.chat_step_reasoning() : m.chat_step_note()}
                    </span>
                    <span
                        className={cx('min-w-0 truncate text-xs', warn ? 'text-text' : 'text-text-muted')}
                        title={step.text}
                    >
                        {step.text}
                    </span>
                </>
            )}
        </li>
    );
}

function StepList({ steps, live }: { readonly steps: readonly ReadReplyStep[]; readonly live: boolean }) {
    if (steps.length === 0) {
        return live ? <p className="py-0.5 text-sm text-text-muted">{m.chat_steps_starting()}</p> : null;
    }
    return (
        <ol aria-label={m.chat_steps_label()} className="flex flex-col">
            {steps.map((step, index) => (
                // Steps only ever grow at the end, so a position is a stable identity and only new ones slide in.
                <StepLine key={index} step={step} current={live && index === steps.length - 1} />
            ))}
        </ol>
    );
}

/**
 * One agent turn's steps. Live, it ticks through them with an elapsed timer; once a reply ends the turn it folds into
 * "Worked 8 s · 3 steps", which opens again on click; a turn that ended without a reply stays open. Step text is
 * agent output: text nodes only, and nothing in the card is a link or control except its own toggle.
 */
export function StepsCard({ view }: { readonly view: StepsView }) {
    const locale = useLocale();
    const listId = useId();
    const [chosen, setChosen] = useState<boolean | null>(null);
    const live = view.status === 'live';
    const open = live || (chosen ?? view.status === 'unfinished');
    const duration =
        view.endedAt === null ? '' : locale.formatDuration(Date.parse(view.endedAt) - Date.parse(view.startedAt));
    const count = view.steps.length;
    const summary =
        view.status === 'unfinished'
            ? m.chat_steps_unfinished()
            : count === 1
              ? m.chat_steps_worked_one({ duration })
              : m.chat_steps_worked({ duration, count: locale.formatNumber(count) });

    return (
        <section
            aria-label={live ? m.chat_steps_working() : summary}
            aria-busy={live || undefined}
            className={cx(
                'w-full max-w-xl px-3 motion-safe:transition-[background-color,padding] motion-safe:duration-200 motion-safe:ease-enter',
                open ? 'chat-soft py-2' : 'py-0.5',
                live && 'chat-enter',
            )}
        >
            {live ? (
                <div className="flex items-center gap-2 text-sm">
                    <span className="chat-dot" data-pulse="" />
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
                    className="-mx-1 flex items-center gap-1.5 rounded-small px-1 font-mono text-xs text-text-muted hover:text-text"
                >
                    {view.status === 'unfinished' ? <span className="chat-dot" data-tone="warning" /> : null}
                    <span>{summary}</span>
                    {view.status === 'unfinished' ? <span>· {duration}</span> : null}
                    <ChevronRight aria-hidden className="chat-chevron size-3.5" data-open={open ? '' : undefined} />
                </button>
            )}
            <div id={listId} className="chat-fold" data-open={open ? '' : undefined}>
                <div inert={!open} className={open ? 'pt-1.5' : undefined}>
                    <StepList steps={view.steps} live={live} />
                </div>
            </div>
        </section>
    );
}
