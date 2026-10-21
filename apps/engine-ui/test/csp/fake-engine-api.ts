import { AgentId, createProblem, ENGINE_API_PREFIX, MemberId } from '@ptbk/engine-api';
import type { EngineApiClient, EngineApiResponse } from '@ptbk/engine-api';
import { createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';
import type { Page, Route } from '@playwright/test';

/** The agent page the CSP checks visit. */
export const FAKE_AGENT_ID = 'ada';

type Read = (
    engineApi: EngineApiClient,
    match: RegExpExecArray,
    query: URLSearchParams,
    signal: AbortSignal,
) => Promise<EngineApiResponse<unknown>>;

/** The read routes the visited pages call; anything else answers 404. */
const READS: readonly (readonly [RegExp, Read])[] = [
    [/^\/engine$/, (api, _, __, signal) => api.engine.get(signal)],
    [/^\/me$/, (api, _, __, signal) => api.me.get(signal)],
    [/^\/agents$/, (api, _, query, signal) => api.agents.list(Object.fromEntries(query), signal)],
    [/^\/agents\/([\w-]+)$/, (api, [, id = ''], _, signal) => api.agents.get(AgentId.parse(id), signal)],
    [/^\/agents\/([\w-]+)\/status$/, (api, [, id = ''], _, signal) => api.agents.getStatus(AgentId.parse(id), signal)],
    [/^\/members\/([\w-]+)$/, (api, [, id = ''], _, signal) => api.members.get(MemberId.parse(id), signal)],
    [/^\/activity$/, (api, _, query, signal) => api.activity.list(Object.fromEntries(query), signal)],
    [/^\/runs$/, (api, _, query, signal) => api.runs.list(Object.fromEntries(query), signal)],
];

/**
 * Answers the engine API from the in-memory client until the mock engine (M-04) and the loader (M-05) serve the
 * bundle for real (X-04). Same origin as the bundle, so `connect-src 'self'` still applies.
 */
export async function routeFakeEngineApi(page: Page): Promise<void> {
    const engineApi = createInMemoryEngineApiClient({
        seed: {
            engine: { name: 'CSP test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            members: [
                {
                    id: 'member-jana',
                    displayName: 'Jana Nováková',
                    role: 'admin',
                    status: 'active',
                    createdAt: '2026-09-01T00:00:00.000Z',
                    lastSeenAt: null,
                },
            ],
            agents: [
                { id: FAKE_AGENT_ID, source: 'Ada\nPERSONA Research', runState: 'running', visibility: 'public' },
                { id: 'grace', source: 'Grace\nPERSONA Review', createdBy: 'member-jana' },
            ],
        },
    });
    await page.route(`**${ENGINE_API_PREFIX}/**`, async (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname.slice(ENGINE_API_PREFIX.length);
        const signal = AbortSignal.timeout(5_000);
        if (path === '/events') {
            // A stream that ends at once: the app reconnects with backoff, and the page still goes network-idle.
            await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
            return;
        }
        for (const [pattern, read] of READS) {
            const match = pattern.exec(path);
            if (route.request().method() === 'GET' && match !== null) {
                await fulfil(route, await read(engineApi, match, url.searchParams, signal));
                return;
            }
        }
        await fulfil(route, { kind: 'problem', problem: createProblem('not-found') });
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
