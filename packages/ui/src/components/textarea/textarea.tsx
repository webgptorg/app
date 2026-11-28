import type { Ref, TextareaHTMLAttributes } from 'react';

import { CONTROL_HEIGHT, controlClassName, invalidAttribute, TOUCH_HEIGHT } from '../../internal/control';
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
            className={controlClassName(cx(CONTROL_HEIGHT.md, TOUCH_HEIGHT.md, 'py-2', className))}
        />
    );
}
