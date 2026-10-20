import { SIGN_IN_PATH } from '@ptbk/engine-api';

import { safeNextPath } from '../security/safe-url';

export interface BrowserLocation {
    readonly origin: string;
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
    assign(url: string): void;
}

export function signInUrl(location: Omit<BrowserLocation, 'assign'>): string {
    const next = safeNextPath(`${location.pathname}${location.search}${location.hash}`, location.origin) ?? '/';
    return `${SIGN_IN_PATH}?${new URLSearchParams({ next }).toString()}`;
}

/**
 * A full-page navigation to the engine's sign-in page, so the gateway (open code) owns sign-in. Several queries can
 * fail with 401 at once; only the first one navigates.
 */
export function createSignInRedirect(location: BrowserLocation): () => void {
    let redirecting = false;
    return () => {
        if (redirecting) return;
        redirecting = true;
        location.assign(signInUrl(location));
    };
}
