import { CircleCheck, Info, OctagonAlert, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';
import { IconButton } from '../icon-button/icon-button';

export type BannerTone = 'info' | 'success' | 'warning' | 'danger';

export interface BannerProps {
    readonly tone?: BannerTone;
    readonly title?: string;
    readonly action?: ReactNode;
    /** Shows a dismiss button. */
    readonly onDismiss?: () => void;
    readonly className?: string;
    readonly children: ReactNode;
}

const TONE_CLASSES: Readonly<Record<BannerTone, string>> = {
    info: 'bg-(--banner-info-bg)',
    success: 'bg-(--banner-success-bg)',
    warning: 'bg-(--banner-warning-bg)',
    danger: 'bg-(--banner-danger-bg)',
};

const ICON_CLASSES: Readonly<Record<BannerTone, string>> = {
    info: 'text-(--banner-info-border)',
    success: 'text-(--banner-success-border)',
    warning: 'text-(--banner-warning-border)',
    danger: 'text-(--banner-danger-border)',
};

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: OctagonAlert } as const;

/**
 * A message about the page or a section. Warnings and dangers interrupt (`role="alert"`); info and success wait their
 * turn (`role="status"`). The tone has an icon too, so it is never conveyed by colour alone.
 */
export function Banner({ tone = 'info', title, action, onDismiss, className, children }: BannerProps) {
    const messages = useUiMessages();
    const Icon = ICONS[tone];
    return (
        <div
            role={tone === 'warning' || tone === 'danger' ? 'alert' : 'status'}
            className={cx(
                'flex items-start gap-2.5 rounded-(--banner-radius) px-3.5 py-3 text-sm text-(--banner-text)',
                TONE_CLASSES[tone],
                className,
            )}
        >
            <Icon aria-hidden="true" className={cx('mt-0.5 size-4 shrink-0', ICON_CLASSES[tone])} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                {title === undefined ? null : <p className="font-medium">{title}</p>}
                <div className={title === undefined ? undefined : 'text-(--banner-muted)'}>{children}</div>
                {action === undefined ? null : <div className="mt-2 flex flex-wrap gap-2">{action}</div>}
            </div>
            {onDismiss === undefined ? null : (
                <IconButton label={messages.dismiss()} icon={<X />} size="sm" onClick={onDismiss} className="-m-1" />
            )}
        </div>
    );
}
