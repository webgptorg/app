import { useId } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';

export interface PropertyIds {
    /** Names the control: pass it as `aria-labelledby`. */
    readonly labelId: string;
    /** The hint's ID when there is one: pass it as `aria-describedby`. */
    readonly hintId: string | undefined;
}

/**
 * One setting as a row: what it is (and a quiet hint) on the left, its value or control on the right. Rows stack on
 * phones, label over control, so a control never shrinks to fit beside a long label.
 */
export function PropertyRow({
    label,
    hint,
    children,
}: {
    readonly label: string;
    readonly hint?: ReactNode;
    readonly children: ReactNode | ((ids: PropertyIds) => ReactNode);
}) {
    const labelId = useId();
    const hintId = useId();
    const ids = { labelId, hintId: hint === undefined ? undefined : hintId };
    return (
        <div className="grid gap-x-8 gap-y-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-center">
            <div className="flex min-w-0 flex-col gap-0.5">
                <span id={labelId} className="text-sm font-medium">
                    {label}
                </span>
                {hint === undefined ? null : (
                    <span id={hintId} className="text-xs text-text-muted">
                        {hint}
                    </span>
                )}
            </div>
            <div className="flex min-w-0 text-sm sm:justify-end">
                {typeof children === 'function' ? children(ids) : children}
            </div>
        </div>
    );
}

/** Rows separated by hairlines, the way a section's rows are everywhere else. */
export function PropertyList({ className, children }: { readonly className?: string; readonly children: ReactNode }) {
    return <div className={cx('-mt-1 flex flex-col divide-y divide-hairline', className)}>{children}</div>;
}
