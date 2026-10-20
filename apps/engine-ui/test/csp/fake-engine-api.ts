import { createProblem, ENGINE_API_PREFIX } from '@ptbk/engine-api';
import { createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';
import type { EngineApiResponse } from '@ptbk/engine-api';
import type { Page, Route } from '@playwright/test';

/**
 * Answers the engine API from the in-memory client until the mock engine (M-04) and the loader (M-05) serve the
 * bundle for real (X-04). Same origin as the bundle, so `connect-src 'self'` still applies.
 */
export async function routeFakeEngineApi(page: Page): Promise<void> {
    const engineApi = createInMemoryEngineApiClient({
        seed: {
            engine: { name: 'CSP test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            agents: [{ source: 'Ada\nPERSONA Research' }, { source: 'Grace\nPERSONA Review' }],
        },
    });
    await page.route(`**${ENGINE_API_PREFIX}/**`, async (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname.slice(ENGINE_API_PREFIX.length);
        const signal = AbortSignal.timeout(5_000);
        if (route.request().method() === 'GET' && path === '/engine') {
            await fulfil(route, await engineApi.engine.get(signal));
        } else if (route.request().method() === 'GET' && path === '/me') {
            await fulfil(route, await engineApi.me.get(signal));
        } else if (route.request().method() === 'GET' && path === '/agents') {
            await fulfil(route, await engineApi.agents.list(Object.fromEntries(url.searchParams), signal));
        } else {
            await fulfil(route, { kind: 'problem', problem: createProblem('not-found') });
        }
    });
}

async function fulfil(route: Route, response: EngineApiResponse<unknown>): Promise<void> {
    if (response.kind === 'ok') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response.data) });
    } else {
        await route.fulfill({
            status: response.problem.status,
            contentType: 'application/problem+json',
            body: JSON.stringify(response.problem),
        });
    }
}
