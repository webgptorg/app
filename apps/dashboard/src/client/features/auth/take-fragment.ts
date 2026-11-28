import { redirect } from '@tanstack/react-router';
import type { ParsedLocation } from '@tanstack/react-router';

import type { RouterContext } from '../../core/router-context';
import { parseFragmentToken, UNSUBSCRIBE_TOKEN } from './fragment-token';
import type { TokenPurpose } from './fragment-token';

/**
 * `beforeLoad` of `/signup`, `/recover`, `/invites` and `/unsubscribe`: a fragment is moved into memory and the address is replaced by the same
 * path without it, before anything renders. The browser never sent the fragment; now it is not in history either.
 */
export function takeFragment(
    context: RouterContext,
    location: ParsedLocation,
    purpose: TokenPurpose,
    to: '/signup' | '/recover' | '/invites' | '/unsubscribe',
): void {
    if (location.hash === '') {
        return;
    }
    context.fragmentTokens.put(
        purpose,
        purpose === 'unsubscribe'
            ? parseFragmentToken(location.hash, UNSUBSCRIBE_TOKEN)
            : parseFragmentToken(location.hash),
    );
    // The query is no secret and may carry a page hint, e.g. `/recover?via=invite`.
    throw redirect({ to, search: location.search, replace: true });
}
