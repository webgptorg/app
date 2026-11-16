import { Check } from 'lucide-react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { WIZARD_STEPS } from './wizard-search';
import type { WizardStep } from './wizard-search';

export function stepLabel(step: WizardStep): string {
    switch (step) {
        case 'brief':
            return m.wizard_step_brief();
        case 'book':
            return m.wizard_step_book();
        case 'knowledge':
            return m.wizard_step_knowledge();
        case 'test':
            return m.wizard_step_test();
    }
}

/**
 * Where the member is in the wizard. Not links: a step is reached by completing the one before it. Phones get one
 * line instead of the list, which would wrap.
 */
export function WizardStepper({ current }: { readonly current: WizardStep }) {
    const currentIndex = WIZARD_STEPS.indexOf(current);
    return (
        <>
            <p className="text-sm font-semibold sm:hidden">
                {m.wizard_step_of({
                    current: currentIndex + 1,
                    total: WIZARD_STEPS.length,
                    name: stepLabel(current),
                })}
            </p>
            <ol aria-label={m.wizard_steps_label()} className="flex items-center gap-2 text-sm max-sm:hidden">
                {WIZARD_STEPS.map((step, index) => {
                    const done = index < currentIndex;
                    const isCurrent = index === currentIndex;
                    return (
                        <li
                            key={step}
                            aria-current={isCurrent ? 'step' : undefined}
                            className={cx(
                                'flex items-center gap-2',
                                isCurrent ? 'font-medium text-text' : 'text-text-muted',
                            )}
                        >
                            {index === 0 ? null : <span aria-hidden className="h-px w-6 bg-divider lg:w-10" />}
                            {/* A quiet ring, never an inverted disc: the current step's ring is in the text colour. */}
                            <span
                                aria-hidden
                                className={cx(
                                    'flex size-5 shrink-0 items-center justify-center rounded-full text-2xs tabular-nums',
                                    done && 'bg-success-soft text-success',
                                    isCurrent && 'border-[1.5px] border-text',
                                    !done && !isCurrent && 'border border-border',
                                )}
                            >
                                {done ? <Check className="size-3" strokeWidth={3} /> : String(index + 1)}
                            </span>
                            {stepLabel(step)}
                            {done ? <span className="sr-only">{m.wizard_step_completed()}</span> : null}
                        </li>
                    );
                })}
            </ol>
        </>
    );
}
