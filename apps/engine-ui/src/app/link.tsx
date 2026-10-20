import { Anchor } from '@ptbk/ui';
import { createLink } from '@tanstack/react-router';

/**
 * The app's typed router link, styled as `@ptbk/ui`'s `Anchor`: route paths, params and search are type-checked, and
 * links preload their route's code and data on hover and focus (router default `preload: 'intent'`).
 */
export const Link = createLink(Anchor);
