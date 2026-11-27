import type { OnboardingActivity } from '@ptbk/engine-api';
import { Spinner } from '@ptbk/ui';
import { Check, Minus, X } from 'lucide-react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';

const STATUS_LABELS: Readonly<Record<OnboardingActivity['status'], () => string>> = {
    running: m.onboarding_activity_running,
    done: m.onboarding_activity_done,
    failed: m.onboarding_activity_failed,
    skipped: m.onboarding_activity_skipped,
};

function StatusIcon({ status }: { readonly status: OnboardingActivity['status'] }) {
    const box = 'mt-0.5 size-4 shrink-0';
    switch (status) {
        case 'running':
            return <Spinner size="sm" announce={false} className={box} />;
        case 'done':
            return <Check aria-hidden className={cx(box, 'text-text-muted')} strokeWidth={2.5} />;
        case 'failed':
            return <X aria-hidden className={cx(box, 'text-danger')} strokeWidth={2.5} />;
        case 'skipped':
            return <Minus aria-hidden className={cx(box, 'text-text-muted')} />;
    }
}

/**
 * What the engine is doing or did while it sets up, in its order: one line per piece of work, with the engine's reason
 * under a failure. The status is said in words for screen readers; the icon only repeats it.
 */
export function OnboardingActivityList({
    activity,
    className,
}: {
    readonly activity: readonly OnboardingActivity[];
    readonly className?: string;
}) {
    return (
        <ol aria-label={m.onboarding_activity_label()} className={cx('flex flex-col gap-2.5', className)}>
            {activity.map((item) => (
                <li key={item.id} className="flex items-start gap-3 text-sm">
                    <StatusIcon status={item.status} />
                    <div className="flex min-w-0 flex-col gap-0.5">
                        <span
                            className={cx(
                                '[overflow-wrap:anywhere]',
                                item.status === 'skipped' || item.status === 'done' ? 'text-text-muted' : 'text-text',
                            )}
                        >
                            <span className="sr-only">{`${STATUS_LABELS[item.status]()}: `}</span>
                            {item.label}
                            {item.status === 'skipped' ? (
                                <span
                                    aria-hidden
                                    className="text-text-muted"
                                >{` · ${m.onboarding_activity_skipped()}`}</span>
                            ) : null}
                        </span>
                        {item.detail === null ? null : (
                            <span className="text-xs [overflow-wrap:anywhere] text-text-muted">{item.detail}</span>
                        )}
                    </div>
                </li>
            ))}
        </ol>
    );
}
