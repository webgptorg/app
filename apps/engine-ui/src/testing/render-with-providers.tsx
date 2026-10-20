import type { EngineApiClient } from '@ptbk/engine-api';
import type { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { vi } from 'vitest';
import type { Mock } from 'vitest';

import { AppProviders } from '../app/providers';
import { createAppQueryClient } from '../app/query-client';
import { createAppRouter } from '../app/router';
import type { AppRouter } from '../app/router';
import { createTestEngineApi } from './test-engine-api';

export interface RenderWithProvidersOptions {
    /** The URL to start at; defaults to `/`. */
    readonly path?: string;
    /** Defaults to `createTestEngineApi()`. */
    readonly engineApi?: EngineApiClient;
}

export interface RenderedApp extends RenderResult {
    readonly router: AppRouter;
    readonly engineApi: EngineApiClient;
    readonly queryClient: QueryClient;
    /** Stands in for the full-page navigation to the engine's sign-in page. */
    readonly onUnauthenticated: Mock<() => void>;
    readonly user: UserEvent;
}

/** The whole app (router, query client, engine API context) on a memory history, as main.tsx composes it. */
export function renderWithProviders(options: RenderWithProvidersOptions = {}): RenderedApp {
    const engineApi = options.engineApi ?? createTestEngineApi();
    const onUnauthenticated = vi.fn<() => void>();
    const queryClient = createAppQueryClient({ onUnauthenticated });
    const router = createAppRouter(
        { engineApi, queryClient },
        createMemoryHistory({ initialEntries: [options.path ?? '/'] }),
    );
    const user = userEvent.setup();
    const result = render(<AppProviders engineApi={engineApi} queryClient={queryClient} router={router} />);
    return { ...result, router, engineApi, queryClient, onUnauthenticated, user };
}
