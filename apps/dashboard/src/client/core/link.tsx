import { Anchor } from '@ptbk/ui';
import { createLink } from '@tanstack/react-router';

/** The app's typed router link, styled as `@ptbk/ui`'s `Anchor`; it preloads its route on hover and focus. */
export const Link = createLink(Anchor);
