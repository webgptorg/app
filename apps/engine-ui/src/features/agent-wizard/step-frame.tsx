import type { ReactNode, Ref } from 'react';

export interface StepFrameProps {
    readonly title: string;
    readonly description: ReactNode;
    /** The wizard moves focus here when the step changes, so screen readers start at the new step. */
    readonly headingRef: Ref<HTMLHeadingElement>;
    readonly children?: ReactNode;
    /** The step's actions: back on the start side, forward on the end side. */
    readonly actions: ReactNode;
}

/** One wizard step: its heading, what it is for, its content and its actions. */
export function StepFrame({ title, description, headingRef, children, actions }: StepFrameProps) {
    return (
        <section aria-labelledby="wizard-step-title" className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-col gap-1">
                <h2
                    id="wizard-step-title"
                    ref={headingRef}
                    tabIndex={-1}
                    className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-focus"
                >
                    {title}
                </h2>
                <p className="text-sm text-text-muted">{description}</p>
            </div>
            {children}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-divider pt-4">
                {actions}
            </div>
        </section>
    );
}
