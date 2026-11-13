import type { Ref, SelectHTMLAttributes } from 'react';

import { controlClassName, invalidAttribute } from '../../internal/control';
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
            className={controlClassName(cx('min-h-9 cursor-pointer pe-8', className))}
        >
            {children}
        </select>
    );
}
