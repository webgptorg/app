import type { PreferenceStorage } from '@ptbk/ui';
import { createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';

import { apiRoutes } from '../../shared/api/routes';
import type { ApiClient } from '../api/api-client';
import type { SessionView } from '../../shared/api/routes';
import { App } from '../app';
import { createFakePasskeys } from './fake-passkeys';
import type { FakePasskeys } from './fake-passkeys';
import { NOW } from './fixtures';
import { createMemorySessionStorage, createMemoryStorage } from './memory-storage';
import { createScriptedApi, ok, problem } from './scripted-api';
import type { ScriptedApi } from './scripted-api';

export interface RenderAppOptions {
    readonly path?: string;
    /** The session `GET /api/session` answers with; `null` (default) is signed out (401). */
    readonly session?: SessionView | null;
    /** Called after the defaults are scripted, to add or override answers. */
    readonly script?: (api: ScriptedApi) => void;
    readonly storage?: PreferenceStorage;
    /** The tab's `sessionStorage`; empty by default. */
    readonly sessionStorage?: ReturnType<typeof createMemorySessionStorage>;
    /** Replaces the scripted API, e.g. with the real client over a fake `fetch`. */
    readonly apiClient?: ApiClient;
    /**
     * Fake timers: the app's clock reads `Date.now()` instead of the fixed `NOW`, and user events advance the timers,
     * for screens that change with time. The test installs them (`vi.useFakeTimers({ shouldAdvanceTime: true })`).
     */
    readonly fakeTimers?: { readonly advance: (ms: number) => unknown };
    /** Scripts the authenticator before the first render, for ceremonies a screen starts on mount. */
    readonly passkeys?: (passkeys: FakePasskeys) => void;
}

export interface RenderedApp extends RenderResult {
    readonly api: ScriptedApi;
    readonly passkeys: FakePasskeys;
    readonly history: RouterHistory;
    readonly user: UserEvent;
    readonly storage: PreferenceStorage;
    readonly sessionStorage: ReturnType<typeof createMemorySessionStorage>;
    /** URLs the app sent the browser to at the top level, in order. */
    readonly navigations: readonly string[];
}

/** The origin every app test runs on. */
export const APP_ORIGIN = 'https://app.ptbk.test';

/** The whole app as `main.tsx` composes it, on a memory history with a scripted API and authenticator. */
export function renderApp(options: RenderAppOptions = {}): RenderedApp {
    const api = createScriptedApi();
    const session = options.session ?? null;
    api.on(apiRoutes.getEnvironment, ok({ environment: 'production' as const }));
    api.on(apiRoutes.getSession, session === null ? problem(401, 'unauthorized') : ok(session));
    api.on(apiRoutes.listEngines, ok({ engines: [] }));
    api.on(apiRoutes.listTeams, ok({ teams: [] }));
    api.on(apiRoutes.listLinkCodes, ok({ linkCodes: [] }));
    options.script?.(api);
    const passkeys = createFakePasskeys();
    options.passkeys?.(passkeys);
    const storage = options.storage ?? createMemoryStorage();
    const sessionStorage = options.sessionStorage ?? createMemorySessionStorage();
    const history = createMemoryHistory({ initialEntries: [options.path ?? '/'] });
    const user =
        options.fakeTimers === undefined
            ? userEvent.setup()
            : userEvent.setup({ advanceTimers: options.fakeTimers.advance });
    const navigations: string[] = [];
    const result = render(
        <App
            apiClient={options.apiClient ?? api}
            browser={{
                storage,
                sessionStorage,
                matchMedia: (query) => window.matchMedia(query),
                passkeys,
                now: options.fakeTimers === undefined ? () => NOW : () => Date.now(),
                origin: APP_ORIGIN,
                navigate: (url) => {
                    navigations.push(url);
                },
            }}
            history={history}
        />,
    );
    return { ...result, api, passkeys, history, user, storage, sessionStorage, navigations };
}
