import type { InputHTMLAttributes, Ref } from 'react';

import { controlClassName, invalidAttribute } from '../../internal/control';
import { cx } from '../../internal/cx';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    readonly invalid?: boolean;
    readonly ref?: Ref<HTMLInputElement>;
}

export function Input({ invalid, className, type = 'text', ...rest }: InputProps) {
    return (
        <input
            {...rest}
            type={type}
            aria-invalid={invalidAttribute(invalid, rest['aria-invalid'])}
            className={controlClassName(cx('min-h-10', className))}
        />
    );
}
