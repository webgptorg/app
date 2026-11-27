import { CalendarDays } from 'lucide-react';
import type { InputHTMLAttributes, Ref } from 'react';

import { CONTROL_HEIGHT, controlClassName, invalidAttribute, TOUCH_HEIGHT } from '../../internal/control';
import { cx } from '../../internal/cx';

export interface DateInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
    /** A date and a time of day (`datetime-local`) instead of a date. */
    readonly withTime?: boolean;
    readonly invalid?: boolean;
    readonly ref?: Ref<HTMLInputElement>;
    /** Sizes the control; the input fills it. */
    readonly className?: string;
}

/**
 * A native date input styled like `Input`. The native control is keyboard- and screen-reader-accessible, orders the
 * date for the browser's locale and opens the platform picker on mobile; a calendar grid of our own would be a large
 * accessibility surface for little gain.
 */
export function DateInput({ withTime = false, invalid, className, ...rest }: DateInputProps) {
    return (
        <span className={cx('relative block', className)}>
            <input
                {...rest}
                type={withTime ? 'datetime-local' : 'date'}
                data-ptbk-date-input=""
                aria-invalid={invalidAttribute(invalid, rest['aria-invalid'])}
                className={controlClassName(cx(CONTROL_HEIGHT.md, TOUCH_HEIGHT.md, 'relative pe-10 tabular-nums'))}
            />
            <CalendarDays
                aria-hidden="true"
                data-ptbk-date-input-icon=""
                className="pointer-events-none absolute inset-y-0 end-3 my-auto size-4 text-(--date-input-icon)"
            />
        </span>
    );
}
