import { createProblem, ENGINE_API_PREFIX, SIGN_IN_PATH } from '@ptbk/engine-api';
import { screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CspViolation } from '../security/csp-violation-listener';
import { createFakeMatchMedia } from '../testing/fake-match-media';
import { createMemoryStorage } from '../testing/memory-storage';
import { createTestEngineApi } from '../testing/test-engine-api';
import { bootstrap } from './bootstrap';
import type { BrowserDeps, MountedApp } from './bootstrap';

const urlOf = (input: RequestInfo | URL): URL =>
    new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

const json = (body: unknown, status = 200, type = 'application/json') =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

/** Answers the API from the in-memory engine, the way an engine would over HTTP. */
async function engineResponse(url: URL): Promise<Response> {
    const engineApi = createTestEngineApi();
    const signal = AbortSignal.timeout(1000);
    const path = url.pathname.slice(ENGINE_API_PREFIX.length);
    const result =
        path === '/engine'
            ? await engineApi.engine.get(signal)
            : path === '/me'
              ? await engineApi.me.get(signal)
              : await engineApi.agents.list({ sort: 'name' }, signal);
    if (result.kind === 'problem') throw new Error('the in-memory engine refused a seed request');
    return json(result.data);
}

let app: MountedApp | undefined;

afterEach(() => {
    act(() => app?.unmount());
    app = undefined;
    document.body.replaceChildren();
});

function setUp(fetch: BrowserDeps['fetch']) {
    window.history.replaceState(null, '', '/agents?sort=name');
    const container = document.body.appendChild(document.createElement('div'));
    const assign = vi.fn<(url: string) => void>();
    const browser: BrowserDeps = {
        document,
        location: {
            origin: window.location.origin,
            pathname: window.location.pathname,
            search: window.location.search,
            hash: window.location.hash,
            assign,
        },
        fetch,
        cspScope: window,
        storage: createMemoryStorage(),
        matchMedia: createFakeMatchMedia().matchMedia,
        timeZone: 'UTC',
    };
    return { container, assign, browser };
}

describe('bootstrap', () => {
    it('renders the app against the engine API over fetch', async () => {
        const fetch = vi.fn<BrowserDeps['fetch']>((input) => engineResponse(urlOf(input)));
        const { container, browser } = setUp(fetch);

        app = await bootstrap(container, browser);

        expect(await screen.findByRole('heading', { name: 'Agents' })).toBeDefined();
        expect(screen.getByText('Ada')).toBeDefined();
        expect(fetch.mock.calls.map(([input]) => urlOf(input).pathname)).toContain(`${ENGINE_API_PREFIX}/agents`);
    });

    it('navigates to the sign-in page with next when the engine answers 401', async () => {
        const problem = createProblem('unauthenticated');
        const fetch = vi.fn<BrowserDeps['fetch']>(() =>
            Promise.resolve(json(problem, 401, 'application/problem+json')),
        );
        const { container, assign, browser } = setUp(fetch);

        app = await bootstrap(container, browser);

        await waitFor(() => {
            expect(assign).toHaveBeenCalledExactlyOnceWith(`${SIGN_IN_PATH}?next=%2Fagents%3Fsort%3Dname`);
        });
    });

    it('records CSP violations for the test harness and logs them in dev', async () => {
        const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const fetch = vi.fn<BrowserDeps['fetch']>((input) => engineResponse(urlOf(input)));
        const { container, browser } = setUp(fetch);
        app = await bootstrap(container, browser);

        document.dispatchEvent(
            Object.assign(new Event('securitypolicyviolation'), {
                effectiveDirective: 'script-src-elem',
                blockedURI: 'inline',
                sourceFile: '',
                lineNumber: 1,
                columnNumber: 1,
            }),
        );

        expect(window.__ptbkCspViolations).toEqual<CspViolation[]>([
            { directive: 'script-src-elem', blockedUri: 'inline', sourceFile: '', line: 1, column: 1 },
        ]);
        expect(logError).toHaveBeenCalledOnce();
    });
});
