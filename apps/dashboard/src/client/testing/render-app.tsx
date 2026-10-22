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
import { createMemoryStorage } from './memory-storage';
import { createScriptedApi, ok, problem } from './scripted-api';
import type { ScriptedApi } from './scripted-api';

export interface RenderAppOptions {
    readonly path?: string;
    /** The session `GET /api/session` answers with; `null` (default) is signed out (401). */
    readonly session?: SessionView | null;
    /** Called after the defaults are scripted, to add or override answers. */
    readonly script?: (api: ScriptedApi) => void;
    readonly storage?: PreferenceStorage;
    /** Replaces the scripted API, e.g. with the real client over a fake `fetch`. */
    readonly apiClient?: ApiClient;
}

export interface RenderedApp extends RenderResult {
    readonly api: ScriptedApi;
    readonly passkeys: FakePasskeys;
    readonly history: RouterHistory;
    readonly user: UserEvent;
    readonly storage: PreferenceStorage;
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
    options.script?.(api);
    const passkeys = createFakePasskeys();
    const storage = options.storage ?? createMemoryStorage();
    const history = createMemoryHistory({ initialEntries: [options.path ?? '/'] });
    const user = userEvent.setup();
    const navigations: string[] = [];
    const result = render(
        <App
            apiClient={options.apiClient ?? api}
            browser={{
                storage,
                matchMedia: (query) => window.matchMedia(query),
                passkeys,
                now: () => NOW,
                origin: APP_ORIGIN,
                navigate: (url) => {
                    navigations.push(url);
                },
            }}
            history={history}
        />,
    );
    return { ...result, api, passkeys, history, user, storage, navigations };
}
