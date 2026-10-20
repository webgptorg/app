import type { HTMLAttributes, ReactNode } from 'react';

export interface VisuallyHiddenProps extends HTMLAttributes<HTMLSpanElement> {
    readonly children: ReactNode;
}

/** Text for assistive technology only. */
export function VisuallyHidden({ children, className, ...rest }: VisuallyHiddenProps) {
    return (
        <span {...rest} className={className === undefined ? 'sr-only' : `sr-only ${className}`}>
            {children}
        </span>
    );
}
