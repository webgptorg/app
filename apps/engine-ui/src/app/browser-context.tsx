import type { PreferenceStorage } from '@ptbk/ui';
import { createContext, use } from 'react';
import type { ReactNode } from 'react';

import type { BrowserLocation } from './sign-in-redirect';
import type { ThemeMatchMedia } from './theme';

/** The browser APIs components reach for, injected at the composition root so tests can stand in for them. */
export interface AppBrowser {
    /** Preferences (theme, language, sidebar); `undefined` when the browser refuses storage. */
    readonly storage: PreferenceStorage | undefined;
    readonly matchMedia: ThemeMatchMedia;
    /** For full-page navigations to the engine's gateway pages (sign-in, sign-out, step-up). */
    readonly location: BrowserLocation;
    readonly fetch: typeof fetch;
}

const BrowserContext = createContext<AppBrowser | null>(null);

export function BrowserProvider({ browser, children }: { readonly browser: AppBrowser; readonly children: ReactNode }) {
    return <BrowserContext value={browser}>{children}</BrowserContext>;
}

export function useBrowser(): AppBrowser {
    const browser = use(BrowserContext);
    if (browser === null) throw new Error('useBrowser() needs a <BrowserProvider> above it');
    return browser;
}
