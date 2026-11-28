import type { Ref, SelectHTMLAttributes } from 'react';

import { CONTROL_HEIGHT, controlClassName, invalidAttribute, TOUCH_HEIGHT } from '../../internal/control';
import { cx } from '../../internal/cx';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
    readonly invalid?: boolean;
    readonly ref?: Ref<HTMLSelectElement>;
}

/** A native `<select>`: it is accessible and keyboard-operable everywhere, and mobile browsers show their own picker. */
export function Select({ invalid, className, children, ...rest }: SelectProps) {
    return (
        <select
            {...rest}
            aria-invalid={invalidAttribute(invalid, rest['aria-invalid'])}
            className={controlClassName(cx(CONTROL_HEIGHT.md, TOUCH_HEIGHT.md, 'cursor-pointer pe-8', className))}
        >
            {children}
        </select>
    );
}
