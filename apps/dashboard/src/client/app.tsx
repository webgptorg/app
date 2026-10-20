import { Toaster } from '@ptbk/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { useState } from 'react';

import type { ApiClient } from './api/api-client';
import { ApiClientProvider } from './api/api-client-context';
import { createAppQueryClient } from './api/queries';
import { BrowserProvider } from './core/browser';
import type { AppBrowser } from './core/browser';
import { ThemeProvider } from './core/theme';
import { createFragmentTokens } from './features/auth/fragment-token';
import { createSessionEndedHandler } from './features/session/end-session';
import { StepUpProvider } from './features/step-up/step-up';
import { LocaleProvider } from './i18n/locale';
import { createAppRouter } from './router';
import type { AppRouter } from './router';

export interface AppProps {
    readonly apiClient: ApiClient;
    readonly browser: AppBrowser;
    /** Tests start on a memory history; the app uses the browser's. */
    readonly history?: RouterHistory;
}

function createAppState(props: AppProps) {
    const created: { router?: AppRouter } = {};
    const queryClient = createAppQueryClient({
        onUnauthenticated: () => {
            onSessionEnded();
        },
    });
    const onSessionEnded = createSessionEndedHandler(queryClient, () => {
        if (created.router === undefined) {
            throw new Error('the router is created with the query client');
        }
        return created.router;
    });
    const router = createAppRouter(
        { queryClient, apiClient: props.apiClient, fragmentTokens: createFragmentTokens() },
        {
            matchMedia: props.browser.matchMedia,
            ...(props.history === undefined ? {} : { history: props.history }),
        },
    );
    created.router = router;
    return { queryClient, router };
}

/** Everything below `main.tsx`; tests render it with a fake {@link ApiClient} and fake browser APIs. */
export function App(props: AppProps) {
    const [{ queryClient, router }] = useState(() => createAppState(props));
    return (
        <BrowserProvider browser={props.browser}>
            <ThemeProvider storage={props.browser.storage} matchMedia={props.browser.matchMedia}>
                <LocaleProvider>
                    <ApiClientProvider client={props.apiClient}>
                        <QueryClientProvider client={queryClient}>
                            <StepUpProvider>
                                <RouterProvider router={router} />
                            </StepUpProvider>
                        </QueryClientProvider>
                    </ApiClientProvider>
                    <Toaster />
                </LocaleProvider>
            </ThemeProvider>
        </BrowserProvider>
    );
}
