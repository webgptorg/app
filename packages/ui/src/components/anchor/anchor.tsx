import type { AnchorHTMLAttributes, Ref } from 'react';

import { cx } from '../../internal/cx';

export type AnchorVariant = 'inline' | 'standalone';

export interface AnchorProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
    /** `inline` sits in running text and is always underlined; `standalone` (navigation, actions) underlines on hover. */
    readonly variant?: AnchorVariant;
    readonly ref?: Ref<HTMLAnchorElement>;
}

/**
 * A styled `<a>` with no routing of its own. Apps make their typed router link from it (TanStack Router's
 * `createLink(Anchor)`), so every prop the router passes (href, handlers, `data-status`, ref) lands on the element.
 */
export function Anchor({ variant = 'inline', className, children, ...rest }: AnchorProps) {
    return (
        <a
            {...rest}
            className={cx(
                'rounded-small text-(--anchor-text) hover:text-(--anchor-text-hover)',
                'motion-safe:transition-[color,background-color,border-color,text-decoration-color] motion-safe:duration-(--motion-state)',
                variant === 'inline' ? 'underline underline-offset-2' : 'no-underline hover:underline',
                className,
            )}
        >
            {children}
        </a>
    );
}
