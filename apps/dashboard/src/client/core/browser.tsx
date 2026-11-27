import type { PreferenceStorage } from '@ptbk/ui';
import { createContext, use } from 'react';
import type { ReactNode } from 'react';

import type { OwnerSetupStorage } from '../features/engines/owner-handoff';
import type { PasskeyAuthenticator } from '../features/passkeys/passkey-authenticator';

/** `window.matchMedia`, injected so tests can drive the system theme and reduced motion. */
export type AppMatchMedia = (
    query: string,
) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;

/** The browser APIs the app reaches for, injected at the composition root so tests can stand in for them. */
export interface AppBrowser {
    /** Theme preference; `undefined` when the browser refuses storage. */
    readonly storage: PreferenceStorage | undefined;
    /** This tab's `sessionStorage`, for the owner setup secret only; `undefined` when the browser refuses storage. */
    readonly sessionStorage: OwnerSetupStorage | undefined;
    readonly matchMedia: AppMatchMedia;
    /** WebAuthn ceremonies; `@simplewebauthn/browser` in the app, a scripted fake in tests. */
    readonly passkeys: PasskeyAuthenticator;
    /** Milliseconds since the epoch, injected so cooldowns and "last used" render deterministically in tests. */
    readonly now: () => number;
    /** The page's own origin, to tell same-origin destinations from external ones. */
    readonly origin: string;
    /** Leaves the SPA for `url` at the top level (Stripe Checkout, the billing portal); `location.assign` in the app. */
    readonly navigate: (url: string) => void;
}

const BrowserContext = createContext<AppBrowser | null>(null);

export function BrowserProvider(props: { readonly browser: AppBrowser; readonly children: ReactNode }) {
    return <BrowserContext value={props.browser}>{props.children}</BrowserContext>;
}

export function useBrowser(): AppBrowser {
    const browser = use(BrowserContext);
    if (browser === null) {
        throw new Error('useBrowser needs a BrowserProvider');
    }
    return browser;
}
