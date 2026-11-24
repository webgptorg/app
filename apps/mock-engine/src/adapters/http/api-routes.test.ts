import { ENGINE_API_PREFIX } from '@ptbk/engine-api';
import { createInMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import { afterEach, describe, expect, it } from 'vitest';

import type { ApiHarness } from '../../testing/api-harness';
import { HARNESS_ORIGIN, createApiHarness } from '../../testing/api-harness';
import { RATE_LIMITS } from '../../domain/rate-limit/rate-limiter';
import { createEngineApiRoutes } from './api-routes';

let harness: ApiHarness | undefined;
afterEach(async () => {
    await harness?.close();
    harness = undefined;
});

/** An owner on a core with every capability, so capability routes answer too. */
async function owner() {
    harness = await createApiHarness({ core: createInMemoryEngineCore() });
    const cookie = harness.signIn({ memberId: 'member-owner' });
    return { fetch: harness.fetch(cookie), harness };
}

const url = (path: string): string => `${HARNESS_ORIGIN}${ENGINE_API_PREFIX}${path}`;

async function problem(response: Response) {
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    return (await response.json()) as { status: number; code: string; errors?: { path: string }[] };
}

describe('engine API routes', () => {
    it('are declared from the route table, one per operation', () => {
        const core = createInMemoryEngineCore();
        const routes = createEngineApiRoutes({ core: () => core });
        const testChat = `${ENGINE_API_PREFIX}/agents/{agentId}/test-chat`;
        expect(routes.every((route) => route.auth === 'session')).toBe(true);
        const voice = [
            `${ENGINE_API_PREFIX}/chats/{chatId}/transcriptions`,
            `${ENGINE_API_PREFIX}/chats/{chatId}/messages/{messageId}/speech`,
        ];
        const aiTools = [
            `${ENGINE_API_PREFIX}/ai-tools/{aiToolId}/check`,
            `${ENGINE_API_PREFIX}/ai-tools/{aiToolId}/sign-ins/{signInId}/answer`,
        ];
        expect(
            routes
                .filter(
                    (route) => route.path !== testChat && !voice.includes(route.path) && !aiTools.includes(route.path),
                )
                .every((route) => route.rateLimit === 'engine-api-ip'),
        ).toBe(true);
        expect(routes.filter((route) => aiTools.includes(route.path)).map((route) => route.rateLimit)).toEqual([
            'engine-api-ai-tools-ip',
            'engine-api-ai-tools-ip',
        ]);
        expect(routes.filter((route) => voice.includes(route.path)).map((route) => route.rateLimit)).toEqual([
            'engine-api-voice-ip',
            'engine-api-voice-ip',
        ]);
        expect(routes.find((route) => route.path === testChat)?.rateLimit).toBe('engine-api-test-chat-ip');
        const stream = routes.find((route) => route.path === `${ENGINE_API_PREFIX}/events`);
        expect(stream?.headers?.safeParse({ 'last-event-id': '12' }).success).toBe(true);
        expect(stream?.headers?.safeParse({ 'last-event-id': 'x'.repeat(65) }).success).toBe(false);
        expect(routes.find((route) => route.path === `${ENGINE_API_PREFIX}/agents`)?.headers).toBeNull();
    });

    it('route literal segments before parameters', async () => {
        const { fetch } = await owner();
        const validate = await fetch(url('/agents/validate'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: 'Ada' }),
        });
        expect(validate.status).toBe(200);
        expect(await validate.json()).toEqual([]);
        const stats = await fetch(url('/runs/stats'));
        expect(stats.status).toBe(200);
        expect(await stats.json()).toMatchObject({ running: 0, queued: 0 });
        expect((await problem(await fetch(url('/runs/run-nope')))).code).toBe('not-found');
    });

    it('refuses a JSON body over its cap with 413 before reading it all', async () => {
        const { fetch } = await owner();
        const response = await fetch(url('/agents/validate'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: 'x'.repeat(2 * 1024 * 1024 + 1) }),
        });
        expect(await problem(response)).toMatchObject({ status: 413, code: 'payload-too-large' });
    });

    it('refuses an invalid or over-long path parameter with 400 on the parameter', async () => {
        const { fetch } = await owner();
        for (const id of ['x'.repeat(65), 'bad%20id']) {
            const refused = await problem(await fetch(url(`/agents/${id}`)));
            expect(refused).toMatchObject({ status: 400, code: 'validation-failed' });
            expect(refused.errors?.every(({ path }) => path.startsWith('params.'))).toBe(true);
        }
    });

    it('refuses unknown query parameters and passes Last-Event-ID on to the stream', async () => {
        const { fetch, harness: running } = await owner();
        const refused = await problem(await fetch(url('/agents?surprise=1')));
        expect(refused).toMatchObject({ status: 400, code: 'validation-failed' });
        expect(refused.errors?.[0]?.path).toBe('query');
        running.core().controller.emit({ type: 'agent.changed', agentId: 'agent-1' });
        running.core().controller.emit({ type: 'agent.changed', agentId: 'agent-2' });
        const abort = new AbortController();
        const events = await fetch(url('/events'), { headers: { 'last-event-id': '1' }, signal: abort.signal });
        expect(events.headers.get('content-type')).toBe('text/event-stream');
        const reader = events.body?.getReader();
        const chunk = await reader?.read();
        expect(new TextDecoder().decode(chunk?.value)).toContain('"agentId":"agent-2"');
        abort.abort();
        await reader?.cancel().catch(() => undefined);
        expect(running.recorder.violations).toEqual([]);
    });

    it('limits draft test replies per client on their own budget, apart from the rest of the API', async () => {
        const { fetch } = await owner();
        const agent = (await (
            await fetch(url('/agents'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ source: 'Ada' }),
            })
        ).json()) as { id: string };
        const testOnce = async () => {
            const response = await fetch(url(`/agents/${agent.id}/test-chat`), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ book: 'Ada', messages: [{ role: 'user', content: 'hi' }] }),
            });
            await response.body?.cancel();
            return response.status;
        };
        const statuses = [];
        for (let index = 0; index <= RATE_LIMITS['engine-api-test-chat-ip'].limit; index++)
            statuses.push(await testOnce());
        expect(statuses.slice(0, -1).every((status) => status === 200)).toBe(true);
        expect(statuses.at(-1)).toBe(429);
        expect((await fetch(url('/agents'))).status).toBe(200);
    });
});
