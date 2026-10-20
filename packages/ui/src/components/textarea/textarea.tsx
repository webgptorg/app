import type { Ref, TextareaHTMLAttributes } from 'react';

import { controlClassName, invalidAttribute } from '../../internal/control';
import { cx } from '../../internal/cx';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
    readonly invalid?: boolean;
    readonly ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ invalid, className, rows = 4, ...rest }: TextareaProps) {
    return (
        <textarea
            {...rest}
            rows={rows}
            aria-invalid={invalidAttribute(invalid, rest['aria-invalid'])}
            className={controlClassName(cx('py-2', className))}
        />
    );
}
