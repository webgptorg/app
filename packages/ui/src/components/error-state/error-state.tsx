import { CircleAlert } from 'lucide-react';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';
import { Button } from '../button/button';

export interface ErrorStateProps {
    /** Defaults to the generic "something went wrong". */
    readonly title?: string;
    readonly message: string;
    /** Shows a retry button. */
    readonly onRetry?: () => void;
    /** The retry is in flight. */
    readonly retrying?: boolean;
    /** Technical detail (a problem code, a correlation ID) behind a disclosure, never the first thing users read. */
    readonly details?: string;
    readonly className?: string;
}

export function ErrorState({ title, message, onRetry, retrying = false, details, className }: ErrorStateProps) {
    const messages = useUiMessages();
    return (
        <div role="alert" className={cx('flex flex-col items-center gap-3 px-6 py-10 text-center', className)}>
            <CircleAlert aria-hidden="true" className="size-8 text-(--error-state-icon)" />
            <p className="font-display text-lg font-semibold text-(--error-state-title)">
                {title ?? messages.errorTitle()}
            </p>
            <p className="max-w-prose text-sm text-(--error-state-message)">{message}</p>
            {onRetry === undefined ? null : (
                <Button variant="primary" loading={retrying} onClick={onRetry}>
                    {messages.retry()}
                </Button>
            )}
            {details === undefined ? null : (
                <details className="max-w-full text-start text-sm text-(--error-state-message)">
                    <summary className="cursor-pointer rounded-small">{messages.errorDetails()}</summary>
                    <pre className="mt-2 overflow-x-auto rounded-small bg-(--error-state-details-bg) p-2 font-mono text-xs whitespace-pre-wrap">
                        {details}
                    </pre>
                </details>
            )}
        </div>
    );
}
