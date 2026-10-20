import type { EngineApiClient } from '@ptbk/engine-api';
import { Toaster } from '@ptbk/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useMemo } from 'react';

import { StepUpProvider } from '../features/step-up/step-up';
import { BrowserProvider } from './browser-context';
import type { AppBrowser } from './browser-context';
import { EngineApiProvider } from './engine-api-context';
import { createEngineEvents } from './engine-events';
import type { EngineEvents } from './engine-events';
import { EngineEventsProvider } from './engine-events-context';
import { LocaleProvider } from './locale';
import type { AppRouter } from './router';
import { ThemeProvider } from './theme';

export interface AppProvidersProps {
    readonly engineApi: EngineApiClient;
    readonly queryClient: QueryClient;
    readonly router: AppRouter;
    readonly browser: AppBrowser;
    /** Defaults to the engine's own `GET /events` stream through `engineApi`. */
    readonly engineEvents?: EngineEvents;
}

export function AppProviders({ engineApi, queryClient, router, browser, engineEvents }: AppProvidersProps) {
    const defaultEvents = useMemo(() => createEngineEvents({ engineApi }), [engineApi]);
    return (
        <BrowserProvider browser={browser}>
            <ThemeProvider storage={browser.storage} matchMedia={browser.matchMedia}>
                {/* Renders UiProvider, so every @ptbk/ui component and the Toaster below get the messages. */}
                <LocaleProvider storage={browser.storage}>
                    <EngineApiProvider client={engineApi}>
                        <EngineEventsProvider events={engineEvents ?? defaultEvents}>
                            <QueryClientProvider client={queryClient}>
                                <StepUpProvider location={browser.location}>
                                    <RouterProvider router={router} />
                                </StepUpProvider>
                            </QueryClientProvider>
                        </EngineEventsProvider>
                    </EngineApiProvider>
                    <Toaster />
                </LocaleProvider>
            </ThemeProvider>
        </BrowserProvider>
    );
}
