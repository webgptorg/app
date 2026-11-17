import type { PreferenceStorage } from '@ptbk/ui';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { createCspViolationSink, installCspViolationListener } from '../security/csp-violation-listener';
import { createAppEngineApiClient } from './engine-api-client';
import { AppProviders } from './providers';
import { FEATURES } from './features';
import { createAppQueryClient } from './query-client';
import { createAppRouter, preloadMatchedRouteChunks } from './router';
import { createSignInRedirect } from './sign-in-redirect';
import type { BrowserLocation } from './sign-in-redirect';
import type { StepUpPopups } from '../features/step-up/step-up-popup';
import type { ThemeMatchMedia } from './theme';

/** The browser APIs the app touches outside React, passed in so tests can stand in for them. */
export interface BrowserDeps {
    readonly document: Pick<Document, 'addEventListener' | 'removeEventListener'>;
    readonly location: BrowserLocation;
    readonly fetch: typeof fetch;
    readonly cspScope: Pick<Window, '__ptbkCspViolations'>;
    /** Theme and language preferences; `undefined` when the browser refuses storage. */
    readonly storage: PreferenceStorage | undefined;
    readonly matchMedia: ThemeMatchMedia;
    readonly timeZone: string;
    readonly popups?: StepUpPopups | undefined;
}

export interface MountedApp {
    unmount(): void;
}

/** The composition root: builds the client, query client and router, and renders the app into `container`. */
export async function bootstrap(container: HTMLElement, browser: BrowserDeps): Promise<MountedApp> {
    const removeCspListener = installCspViolationListener(
        browser.document,
        createCspViolationSink({
            dev: import.meta.env.DEV,
            scope: browser.cspScope,
            logError: (message, violation) => {
                console.error(message, violation);
            },
        }),
    );
    const engineApi = await createAppEngineApiClient({ origin: browser.location.origin, fetch: browser.fetch });
    const queryClient = createAppQueryClient({ onUnauthenticated: createSignInRedirect(browser.location) });
    const router = createAppRouter({ engineApi, queryClient, features: FEATURES }, { matchMedia: browser.matchMedia });
    preloadMatchedRouteChunks(router);

    let devtools: ReactNode = null;
    // Both conditions are build-time constants, so production builds drop the import and its chunk entirely.
    if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
        const { DevtoolsPanels } = await import('./devtools-panels');
        devtools = <DevtoolsPanels router={router} queryClient={queryClient} />;
    }

    const root = createRoot(container);
    root.render(
        <StrictMode>
            <AppProviders
                engineApi={engineApi}
                queryClient={queryClient}
                router={router}
                browser={{
                    storage: browser.storage,
                    matchMedia: browser.matchMedia,
                    location: browser.location,
                    fetch: browser.fetch,
                    timeZone: browser.timeZone,
                    popups: browser.popups,
                }}
            />
            {devtools}
        </StrictMode>,
    );
    return {
        unmount: () => {
            root.unmount();
            removeCspListener();
        },
    };
}
