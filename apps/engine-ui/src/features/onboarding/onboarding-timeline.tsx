import { Check } from 'lucide-react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';

/**
 * Beyond this many steps a list would stop reading as a timeline, and the count is the engine's to send: past it, or
 * for a count that does not add up, only "Step x of y" is shown.
 */
const MAX_LISTED_STEPS = 12;

export interface SetupProgress {
    readonly step: number;
    readonly of: number;
}

/** Whether the engine's count can be drawn step by step. */
export function listsSteps(progress: SetupProgress): boolean {
    return progress.of <= MAX_LISTED_STEPS && progress.step <= progress.of;
}

function stepNumbers(of: number): number[] {
    return Array.from({ length: of }, (_, index) => index + 1);
}

function Marker({
    number,
    done,
    current,
}: {
    readonly number: number;
    readonly done: boolean;
    readonly current: boolean;
}) {
    // A quiet ring, never an inverted disc, as in the agent wizard's stepper.
    return (
        <span
            aria-hidden
            className={cx(
                'flex size-6 shrink-0 items-center justify-center rounded-full text-2xs font-medium tabular-nums',
                done && 'bg-success-soft text-success',
                current && 'border-[1.5px] border-text text-text',
                !done && !current && 'border border-border text-text-muted',
            )}
        >
            {done ? <Check className="size-3.5" strokeWidth={3} /> : String(number)}
        </span>
    );
}

/**
 * Where setup stands, as the engine counts it: its steps down the side on wide screens. The engine names only the step
 * it asks now, so a step shows its title once this visit has seen it, and its number otherwise; titles of steps still
 * ahead are never guessed, since the engine's path may branch.
 */
export function SetupTimeline({
    progress,
    titles,
    className,
}: {
    readonly progress: SetupProgress;
    /** Titles this visit has seen, by step number. */
    readonly titles: ReadonlyMap<number, string>;
    readonly className?: string;
}) {
    const label = m.onboarding_step({ step: progress.step, of: progress.of });
    if (!listsSteps(progress)) return <p className={cx('meta', className)}>{label}</p>;
    return (
        <div className={cx('flex flex-col gap-4', className)}>
            <p className="meta" aria-hidden>
                {label}
            </p>
            <ol aria-label={m.onboarding_steps_label()} className="flex flex-col gap-5">
                {stepNumbers(progress.of).map((number) => {
                    const done = number < progress.step;
                    const current = number === progress.step;
                    const title = number > progress.step ? undefined : titles.get(number);
                    return (
                        <li
                            key={number}
                            aria-current={current ? 'step' : undefined}
                            className={cx(
                                'relative flex min-w-0 items-center gap-3 text-sm',
                                // The line down to the next marker, through the gap between them.
                                'after:absolute after:start-[calc(0.75rem-0.5px)] after:top-7 after:-bottom-4 after:w-px after:bg-divider last:after:hidden',
                                current ? 'font-medium text-text' : 'text-text-muted',
                            )}
                        >
                            <Marker number={number} done={done} current={current} />
                            <span className="min-w-0 truncate">
                                {title ?? m.onboarding_step_numbered({ step: number })}
                            </span>
                            {done ? <span className="sr-only">{m.onboarding_step_completed()}</span> : null}
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

/**
 * The same progress in one line for narrow screens, where a list down the side has no room: "Step 2 of 6" over a
 * segment per step. The segments only repeat the words.
 */
export function SetupProgressBar({
    progress,
    className,
}: {
    readonly progress: SetupProgress;
    readonly className?: string;
}) {
    return (
        <div className={cx('flex flex-col gap-2', className)}>
            <p className="meta">{m.onboarding_step({ step: progress.step, of: progress.of })}</p>
            {listsSteps(progress) ? (
                <div aria-hidden className="flex gap-1">
                    {stepNumbers(progress.of).map((number) => (
                        <span
                            key={number}
                            className={cx(
                                'h-1 flex-1 rounded-full',
                                number < progress.step && 'bg-text-muted',
                                number === progress.step && 'bg-text',
                                number > progress.step && 'bg-divider',
                            )}
                        />
                    ))}
                </div>
            ) : null}
        </div>
    );
}
