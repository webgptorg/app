import type { ReactNode, Ref } from 'react';

import { cx } from '../../app/cx';

export interface StepFrameProps {
    readonly title: string;
    readonly description: ReactNode;
    /** The wizard moves focus here when the step changes, so screen readers start at the new step. */
    readonly headingRef: Ref<HTMLHeadingElement>;
    /** Form steps stay at a readable line length; the book editor and the test chat use the full width. */
    readonly width?: 'form' | 'full';
    /**
     * Beside a form step on wide screens, e.g. a live preview of the agent being described, so the step uses the page's
     * width without stretching its fields.
     */
    readonly aside?: ReactNode;
    readonly children?: ReactNode;
    /** The step's actions: back on the start side, forward on the end side. */
    readonly actions: ReactNode;
}

/** One wizard step: its heading, what it is for, its content and its actions, and what sits beside it. */
export function StepFrame({
    title,
    description,
    headingRef,
    width = 'full',
    aside,
    children,
    actions,
}: StepFrameProps) {
    const step = (
        <section
            aria-labelledby="wizard-step-title"
            className={cx('flex min-w-0 flex-col gap-5', width === 'form' && 'w-full max-w-2xl')}
        >
            <div className="flex flex-col gap-1">
                <h2
                    id="wizard-step-title"
                    ref={headingRef}
                    tabIndex={-1}
                    className="text-lg font-semibold tracking-heading focus-visible:outline-2 focus-visible:outline-focus"
                >
                    {title}
                </h2>
                <p className="text-sm text-text-muted">{description}</p>
            </div>
            {children}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-4">
                {actions}
            </div>
        </section>
    );
    if (aside === undefined) return step;
    return (
        <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,42rem)_minmax(16rem,22rem)] lg:gap-12">
            {step}
            <aside className="min-w-0 max-lg:hidden">{aside}</aside>
        </div>
    );
}
