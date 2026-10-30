import type { ReadRunDetail, ToolCall } from '@ptbk/engine-api';
import { Banner, Card, Spinner, useLocale } from '@ptbk/ui';
import { ChevronRight, Circle, CircleCheck, CircleStop, CircleX } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { cx } from '../../app/cx';
import { useNow } from '../../app/ticker';
import { m } from '../../paraglide/messages';
import { formatDuration } from './run-format';

type Progress = NonNullable<ReadRunDetail['progress']>;
type StepState = 'done' | 'current' | 'stopped' | 'todo';

/** The first open step is where the run is, or where it ended if it failed or was stopped. */
function stepStates(run: ReadRunDetail, items: Progress['items']): StepState[] {
    const first = items.findIndex((item) => item.status === 'pending');
    return items.map((item, index) => {
        if (item.status === 'completed') return 'done';
        if (index !== first) return 'todo';
        if (run.status === 'running') return 'current';
        if (run.status === 'failed' || run.status === 'cancelled') return 'stopped';
        return 'todo';
    });
}

const STEP_SR_LABEL: Readonly<Record<StepState, () => string>> = {
    done: () => m.run_step_done(),
    current: () => m.run_step_current(),
    stopped: () => m.run_step_stopped(),
    todo: () => m.run_step_pending(),
};

function StepNode({ state, failed, justDone }: { state: StepState; failed: boolean; justDone: boolean }) {
    switch (state) {
        case 'done':
            return (
                <CircleCheck
                    aria-hidden
                    className={cx(
                        'size-4 text-success',
                        justDone && 'motion-safe:animate-[ptbk-run-settle_var(--motion-seal)_var(--ease-enter)]',
                    )}
                />
            );
        case 'current':
            return <Spinner size="sm" announce={false} />;
        case 'stopped':
            return failed ? (
                <CircleX aria-hidden className="size-4 text-danger" />
            ) : (
                <CircleStop aria-hidden className="size-4 text-text-muted" />
            );
        case 'todo':
            return <Circle aria-hidden className="size-4 text-text-muted" />;
    }
}

/**
 * The agent's checklist as a timeline: done steps checked, the current one spinning with what the agent says it is
 * doing, the rest waiting. A step that completes while on screen settles once; ones done before the page opened don't.
 */
export function StepsSection({ run, progress }: { readonly run: ReadRunDetail; readonly progress: Progress }) {
    const locale = useLocale();
    const [doneOnArrival] = useState<ReadonlySet<string>>(
        () => new Set(progress.items.filter((item) => item.status === 'completed').map(({ id }) => id)),
    );
    const states = stepStates(run, progress.items);
    const total = progress.items.length;
    const done = states.filter((state) => state === 'done').length;
    const running = run.status === 'running';
    const currentIndex = states.indexOf('current');
    const nowText = progress.now?.trim() ?? '';
    const nowUnderStep = currentIndex !== -1 && nowText !== '' && nowText !== progress.items[currentIndex]?.text.trim();
    const nowStandalone = running && nowText !== '' && currentIndex === -1;
    return (
        <Card title={m.run_steps_title()}>
            <div className="flex flex-col gap-4" aria-live={running ? 'polite' : 'off'}>
                {total === 0 ? null : (
                    <div className="flex items-center gap-3 text-sm text-text-muted">
                        <div
                            role="progressbar"
                            aria-label={m.run_steps_progress()}
                            aria-valuemin={0}
                            aria-valuemax={total}
                            aria-valuenow={done}
                            className="h-1.5 flex-1 overflow-hidden rounded-pill bg-sunken"
                        >
                            <div
                                className={cx(
                                    'run-progress-fill h-full rounded-pill',
                                    running && 'run-progress-live',
                                    run.status === 'completed' ? 'bg-success' : running ? 'bg-accent' : 'bg-text-muted',
                                )}
                                style={{ width: `${String((done / total) * 100)}%` }}
                            />
                        </div>
                        <span className="shrink-0 tabular-nums">
                            {m.run_steps_count({
                                done: locale.formatNumber(done),
                                total: locale.formatNumber(total),
                            })}
                        </span>
                    </div>
                )}
                {total === 0 ? null : (
                    <ol className="flex flex-col">
                        {progress.items.map((item, index) => {
                            const state = states[index] ?? 'todo';
                            return (
                                <li
                                    key={item.id}
                                    className="run-step relative flex gap-3 pb-3 last:pb-0"
                                    data-state={state}
                                >
                                    <span className="relative z-10 flex size-5 shrink-0 items-center justify-center bg-raised">
                                        <StepNode
                                            state={state}
                                            failed={run.status === 'failed'}
                                            justDone={state === 'done' && !doneOnArrival.has(item.id)}
                                        />
                                    </span>
                                    <span className="flex min-w-0 flex-col gap-0.5 pt-px text-sm">
                                        <span
                                            className={cx(
                                                'break-words',
                                                state === 'current' && 'font-medium',
                                                state === 'todo' && 'text-text-muted',
                                            )}
                                        >
                                            <span className="sr-only">{STEP_SR_LABEL[state]()} </span>
                                            {item.text}
                                        </span>
                                        {state === 'current' && nowUnderStep ? (
                                            <span className="break-words text-text-muted">{nowText}</span>
                                        ) : null}
                                    </span>
                                </li>
                            );
                        })}
                    </ol>
                )}
                {total === 0 || nowStandalone ? (
                    <>
                        {progress.now === null ? null : (
                            <p className="text-sm break-words">
                                <span className="text-text-muted">{m.run_steps_now()} </span>
                                {progress.now}
                            </p>
                        )}
                        {total > 0 || progress.next === null ? null : (
                            <p className="text-sm break-words">
                                <span className="text-text-muted">{m.run_steps_next()} </span>
                                {progress.next}
                            </p>
                        )}
                    </>
                ) : null}
            </div>
        </Card>
    );
}

function toolStateLabel(state: ToolCall['state']): string {
    switch (state) {
        case 'pending':
            return m.run_tool_pending();
        case 'partial':
            return m.run_tool_partial();
        case 'complete':
            return m.run_tool_complete();
        case 'error':
            return m.run_tool_error();
    }
}

function ToolStateIcon({ state, inFlight }: { readonly state: ToolCall['state']; readonly inFlight: boolean }) {
    if (inFlight) return <Spinner size="sm" announce={false} />;
    switch (state) {
        case 'complete':
            return <CircleCheck aria-hidden className="size-4 text-success" />;
        case 'error':
            return <CircleX aria-hidden className="size-4 text-danger" />;
        case 'pending':
        case 'partial':
            return <Circle aria-hidden className="size-4 text-text-muted" />;
    }
}

/** Where in the run a call sat, as a quiet bar beside its duration; decorative, the duration says it in text. */
function TimingBar({ run, call, elapsedMs, now }: TimingProps & { readonly elapsedMs: number }) {
    if (run.startedAt === null || call.startedAt === null) return null;
    const startMs = Date.parse(run.startedAt);
    const span = (run.completedAt === null ? now : Date.parse(run.completedAt)) - startMs;
    if (span <= 0) return null;
    const left = Math.min(1, Math.max(0, (Date.parse(call.startedAt) - startMs) / span));
    const width = Math.min(1 - left, elapsedMs / span);
    return (
        <span aria-hidden="true" className="relative hidden h-1 w-24 shrink-0 rounded-pill bg-sunken sm:block">
            <span
                className="run-timing-fill absolute inset-y-0 min-w-1 rounded-pill bg-accent"
                style={{ left: `${String(left * 100)}%`, width: `${String(width * 100)}%` }}
            />
        </span>
    );
}

interface TimingProps {
    readonly run: ReadRunDetail;
    readonly call: ToolCall;
    readonly now: number;
}

/** The bar and the duration: what the engine reported, else, while the call is in flight, the clock since it began. */
function CallTiming({ run, call, now }: TimingProps) {
    const locale = useLocale();
    let elapsed = call.durationMs;
    if (elapsed === null && call.startedAt !== null && run.status === 'running') {
        elapsed = Math.max(0, now - Date.parse(call.startedAt));
    }
    return (
        <>
            {elapsed === null ? null : <TimingBar run={run} call={call} now={now} elapsedMs={elapsed} />}
            <span className="min-w-12 shrink-0 text-right text-sm whitespace-nowrap text-text-muted tabular-nums">
                {elapsed === null ? null : formatDuration(elapsed, (value) => locale.formatNumber(value))}
            </span>
        </>
    );
}

/** Only a running run's rows tick with the shared clock; a finished run's are fixed. */
function LiveCallTiming(props: Omit<TimingProps, 'now'>) {
    return <CallTiming {...props} now={useNow()} />;
}

/** Keeps a growing log scrolled to its end, unless the member scrolled up to read. */
function useFollowTail(logs: string) {
    const ref = useRef<HTMLPreElement>(null);
    const following = useRef(true);
    const hasLogs = logs !== '';
    useEffect(() => {
        const element = ref.current;
        if (element === null) return;
        const onScroll = () => {
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
        };
        element.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            element.removeEventListener('scroll', onScroll);
        };
    }, [hasLogs]);
    useLayoutEffect(() => {
        const element = ref.current;
        if (element !== null && following.current) element.scrollTop = element.scrollHeight;
    }, [logs]);
    return ref;
}

function ToolCallRow({ run, call }: { readonly run: ReadRunDetail; readonly call: ToolCall }) {
    const running = run.status === 'running';
    const inFlight = running && (call.state === 'pending' || call.state === 'partial');
    // Opens on its own while in flight, so its output streams in view; after that it is the member's to fold.
    const [open, setOpen] = useState(inFlight);
    const tail = useFollowTail(call.logs);
    return (
        <li>
            <details
                className="run-expand group py-2"
                open={open}
                onToggle={(event) => {
                    setOpen(event.currentTarget.open);
                }}
            >
                <summary className="flex cursor-pointer list-none items-center gap-3 rounded-small focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                        <ToolStateIcon state={call.state} inFlight={inFlight} />
                    </span>
                    <span className="min-w-0 flex-1 font-mono text-sm break-all">{call.name}</span>
                    <span className="sr-only">{toolStateLabel(call.state)}</span>
                    {running ? <LiveCallTiming run={run} call={call} /> : <CallTiming run={run} call={call} now={0} />}
                    <ChevronRight
                        aria-hidden
                        className="size-4 shrink-0 text-text-muted transition-transform duration-(--motion-state) group-open:rotate-90"
                    />
                </summary>
                <div className="mt-2 flex flex-col gap-2 pl-8">
                    {call.logsTruncated ? <Banner tone="warning">{m.run_logs_truncated()}</Banner> : null}
                    {call.logs === '' ? (
                        <p className="text-sm text-text-muted">{inFlight ? null : m.run_logs_empty()}</p>
                    ) : (
                        // Tool output is attacker-controlled once an agent reads outside content: text only.
                        <pre
                            ref={tail}
                            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                            tabIndex={0}
                            className="run-text max-h-96 overflow-auto rounded-surface p-3 font-mono text-xs break-words whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-focus"
                        >
                            {call.logs}
                        </pre>
                    )}
                </div>
            </details>
        </li>
    );
}

/** Each call as a row that unfolds to its output: live timers and a bar showing when in the run it ran. */
export function ToolCallsSection({ run }: { readonly run: ReadRunDetail }) {
    return (
        <Card title={m.run_tools_title()}>
            <ul className="flex flex-col divide-y divide-divider">
                {run.toolCalls.map((call) => (
                    <ToolCallRow key={call.id} run={run} call={call} />
                ))}
            </ul>
        </Card>
    );
}
