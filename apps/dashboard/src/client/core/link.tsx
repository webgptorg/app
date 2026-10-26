import { Anchor, buttonClassName } from '@ptbk/ui';
import type { ButtonSize, ButtonVariant } from '@ptbk/ui';
import { createLink } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, Ref } from 'react';

/** The app's typed router link, styled as `@ptbk/ui`'s `Anchor`; it preloads its route on hover and focus. */
export const Link = createLink(Anchor);

interface ButtonAnchorProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
    readonly variant?: ButtonVariant;
    readonly size?: ButtonSize;
    readonly ref?: Ref<HTMLAnchorElement>;
}

function ButtonAnchor({ variant = 'secondary', size = 'md', className, children, ...rest }: ButtonAnchorProps) {
    return (
        <a {...rest} className={buttonClassName(variant, size, className)}>
            {children}
        </a>
    );
}

/** A navigation that looks like a button ("Link an engine"); still a link, so it opens in a new tab and preloads. */
export const ButtonLink = createLink(ButtonAnchor);
