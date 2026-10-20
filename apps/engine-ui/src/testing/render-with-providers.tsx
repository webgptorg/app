import type { CapabilityRef, EngineApiClient, Permission } from '@ptbk/engine-api';
import { THEME_STORAGE_KEY } from '@ptbk/ui';
import type { PreferenceStorage, ThemePreference } from '@ptbk/ui';
import type { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { vi } from 'vitest';
import type { Mock } from 'vitest';

import { LOCALE_STORAGE_KEY } from '../app/locale-storage';
import { FEATURES } from '../app/features';
import { AppProviders } from '../app/providers';
import type { FeatureDefinition } from '../app/registry/feature';
import { createAppQueryClient } from '../app/query-client';
import { createAppRouter } from '../app/router';
import type { AppRouter } from '../app/router';
import { createFakeLocation } from './fake-location';
import type { FakeLocation } from './fake-location';
import { createFakeMatchMedia } from './fake-match-media';
import type { FakeMatchMedia } from './fake-match-media';
import { createMemoryStorage } from './memory-storage';
import { createTestEngineApi } from './test-engine-api';

export interface RenderWithProvidersOptions {
    /** The URL to start at; defaults to `/`. */
    readonly path?: string;
    /** Defaults to `createTestEngineApi()`. */
    readonly engineApi?: EngineApiClient;
    /** Stored before rendering, as if chosen on an earlier visit. */
    readonly locale?: 'en' | 'cs';
    /** Stored before rendering, as if chosen on an earlier visit. */
    readonly theme?: ThemePreference;
    /** Pass the `storage` of an earlier render to simulate a reload; defaults to a fresh, empty one. */
    readonly storage?: PreferenceStorage;
    /** Defaults to a system in light mode. */
    readonly media?: FakeMatchMedia;
    /** The signed-in member's permissions (default: all, as the owner); ignored when `engineApi` is given. */
    readonly permissions?: readonly Permission[];
    /** What `GET /engine` advertises (default: every known capability); ignored when `engineApi` is given. */
    readonly capabilities?: readonly CapabilityRef[];
    /** Replaces the registered features, e.g. with capability-gated fixtures. */
    readonly features?: readonly FeatureDefinition[];
    /** The browser's answer to the sign-out request; defaults to 200. */
    readonly fetch?: typeof fetch;
}

export interface RenderedApp extends RenderResult {
    readonly router: AppRouter;
    readonly engineApi: EngineApiClient;
    readonly queryClient: QueryClient;
    /** Stands in for the full-page navigation to the engine's sign-in page. */
    readonly onUnauthenticated: Mock<() => void>;
    readonly user: UserEvent;
    readonly storage: PreferenceStorage;
    readonly media: FakeMatchMedia;
    /** Records full-page navigations (sign-out, step-up) instead of leaving the test page. */
    readonly location: FakeLocation;
    readonly fetch: Mock<typeof fetch>;
}

/** The whole app (router, query client, engine API context) on a memory history, as main.tsx composes it. */
export function renderWithProviders(options: RenderWithProvidersOptions = {}): RenderedApp {
    const engineApi =
        options.engineApi ??
        createTestEngineApi({
            ...(options.permissions === undefined
                ? {}
                : { member: { permissions: options.permissions, role: 'member' } }),
            ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        });
    const storage = options.storage ?? createMemoryStorage();
    if (options.locale !== undefined) storage.setItem(LOCALE_STORAGE_KEY, options.locale);
    if (options.theme !== undefined) storage.setItem(THEME_STORAGE_KEY, options.theme);
    const media = options.media ?? createFakeMatchMedia();
    const onUnauthenticated = vi.fn<() => void>();
    const queryClient = createAppQueryClient({ onUnauthenticated });
    const router = createAppRouter(
        { engineApi, queryClient, features: options.features ?? FEATURES },
        { history: createMemoryHistory({ initialEntries: [options.path ?? '/'] }), matchMedia: media.matchMedia },
    );
    const location = createFakeLocation(options.path ?? '/');
    const fetch = vi.fn<typeof globalThis.fetch>(
        options.fetch ?? (() => Promise.resolve(new Response(null, { status: 200 }))),
    );
    const user = userEvent.setup();
    const result = render(
        <AppProviders
            engineApi={engineApi}
            queryClient={queryClient}
            router={router}
            browser={{ storage, matchMedia: media.matchMedia, location, fetch }}
        />,
    );
    return { ...result, router, engineApi, queryClient, onUnauthenticated, user, storage, media, location, fetch };
}
