import { Check } from 'lucide-react';

import { m } from '../../../paraglide/messages';

export type LinkStep = 'plan' | 'install' | 'connect' | 'finish';

const STEP_LABELS: Record<LinkStep, () => string> = {
    plan: () => m.link_step_plan(),
    install: () => m.link_step_install(),
    connect: () => m.link_step_connect(),
    finish: () => m.link_step_finish(),
};

/**
 * Where the person is between plan and a ready engine. `current` null means every step is done. On a phone only the
 * current step keeps its label on screen; the others stay readable to screen readers.
 */
export function LinkSteps(props: { readonly steps: readonly LinkStep[]; readonly current: LinkStep | null }) {
    const currentIndex = props.current === null ? props.steps.length : props.steps.indexOf(props.current);
    return (
        <ol aria-label={m.link_steps_label()} className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
            {props.steps.map((step, index) => {
                const done = index < currentIndex;
                const current = index === currentIndex;
                return (
                    <li
                        key={step}
                        data-step={step}
                        aria-current={current ? 'step' : undefined}
                        className="flex items-center gap-2"
                    >
                        {index === 0 ? null : <span aria-hidden className="h-px w-4 bg-divider sm:w-8" />}
                        <span
                            aria-hidden
                            // No inverted disc: the current step is the soft wash the primary button uses, with a ring.
                            className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums ${
                                done
                                    ? 'bg-success-soft text-success'
                                    : current
                                      ? 'bg-(--color-wash-strong) text-text ring-1 ring-text-muted'
                                      : 'border border-divider text-text-muted'
                            }`}
                        >
                            {done ? <Check className="size-3.5" /> : index + 1}
                        </span>
                        <span
                            className={
                                current
                                    ? 'font-medium'
                                    : done
                                      ? 'text-text max-sm:sr-only'
                                      : 'text-text-muted max-sm:sr-only'
                            }
                        >
                            {STEP_LABELS[step]()}
                            {done ? <span className="sr-only"> {m.link_step_done()}</span> : null}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}
