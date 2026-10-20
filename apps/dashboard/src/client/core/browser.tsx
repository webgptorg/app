import type { PreferenceStorage } from '@ptbk/ui';
import { createContext, use } from 'react';
import type { ReactNode } from 'react';

import type { PasskeyAuthenticator } from '../features/passkeys/passkey-authenticator';

/** `window.matchMedia`, injected so tests can drive the system theme and reduced motion. */
export type AppMatchMedia = (
    query: string,
) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;

/** The browser APIs the app reaches for, injected at the composition root so tests can stand in for them. */
export interface AppBrowser {
    /** Theme preference; `undefined` when the browser refuses storage. */
    readonly storage: PreferenceStorage | undefined;
    readonly matchMedia: AppMatchMedia;
    /** WebAuthn ceremonies; `@simplewebauthn/browser` in the app, a scripted fake in tests. */
    readonly passkeys: PasskeyAuthenticator;
    /** Milliseconds since the epoch, injected so cooldowns and "last used" render deterministically in tests. */
    readonly now: () => number;
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
