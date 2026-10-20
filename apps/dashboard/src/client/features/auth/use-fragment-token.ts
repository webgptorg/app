import { useRouter } from '@tanstack/react-router';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { FragmentToken, TokenPurpose } from './fragment-token';

/** The token the route took from the URL fragment, held in this page's state only. */
export function useFragmentToken(purpose: TokenPurpose): FragmentToken {
    const { fragmentTokens } = useRouter().options.context;
    const [token] = useState(() => fragmentTokens.peek(purpose));
    useEffect(() => {
        fragmentTokens.forget(purpose);
    }, [fragmentTokens, purpose]);
    return token;
}

/**
 * Changes whenever a token arrives. An emailed link opened in a tab that already shows the page is a same-document
 * navigation that keeps the page mounted; keying the page by this remounts it, so it reads the new token.
 */
export function useFragmentArrivals(): number {
    const { fragmentTokens } = useRouter().options.context;
    return useSyncExternalStore(fragmentTokens.subscribe, fragmentTokens.arrivals);
}
