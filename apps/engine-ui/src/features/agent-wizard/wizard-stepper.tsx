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
        case 'done':
            return m.wizard_step_done();
    }
}

/** Where the member is in the wizard. Not links: a step is reached by completing the one before it. */
export function WizardStepper({ current }: { readonly current: WizardStep }) {
    const currentIndex = WIZARD_STEPS.indexOf(current);
    return (
        <ol aria-label={m.wizard_steps_label()} className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {WIZARD_STEPS.map((step, index) => {
                const done = index < currentIndex;
                const isCurrent = index === currentIndex;
                return (
                    <li
                        key={step}
                        aria-current={isCurrent ? 'step' : undefined}
                        className={cx(
                            'flex items-center gap-2',
                            isCurrent ? 'font-semibold text-text' : 'text-text-muted',
                        )}
                    >
                        <span
                            aria-hidden
                            className={cx(
                                'flex size-6 items-center justify-center rounded-full border text-xs',
                                isCurrent || done ? 'border-accent bg-accent text-on-accent' : 'border-border',
                            )}
                        >
                            {done ? <Check className="size-3.5" /> : String(index + 1)}
                        </span>
                        {stepLabel(step)}
                        {done ? <span className="sr-only">{m.wizard_step_completed()}</span> : null}
                    </li>
                );
            })}
        </ol>
    );
}
