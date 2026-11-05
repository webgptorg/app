import { ENGINE_API_PREFIX } from '@ptbk/engine-api';
import { IN_MEMORY_CLIENT_MARKER } from '@ptbk/engine-api/in-memory';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppEngineApiClient } from './engine-api-client';

const engineInfo = {
    name: 'Engine',
    engineId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
    hostname: 'engine.example',
    dashboardUrl: null,
    mode: 'tunnel',
    capabilities: [{ id: 'runs', version: 1 }],
};

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('createAppEngineApiClient', () => {
    it('talks HTTP to the origin it was served from', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(() =>
            Promise.resolve(Response.json(engineInfo, { headers: { 'content-type': 'application/json' } })),
        );
        const client = await createAppEngineApiClient({ origin: 'https://engine.example', fetch });

        expect(await client.engine.get(AbortSignal.timeout(1000))).toEqual({ kind: 'ok', data: engineInfo });
        expect(fetch.mock.calls[0]?.[0]).toEqual(new URL(`https://engine.example${ENGINE_API_PREFIX}/engine`));
        expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin', redirect: 'error' });
        expect(Object.prototype.toString.call(client)).not.toContain(IN_MEMORY_CLIENT_MARKER);
    });

    it('swaps in the in-memory client on the dev server with VITE_ENGINE_API=memory', async () => {
        vi.stubEnv('VITE_ENGINE_API', 'memory');
        vi.stubEnv('VITE_ENGINE_PROFILE', 'full');
        const fetch = vi.fn<typeof globalThis.fetch>();
        const client = await createAppEngineApiClient({ origin: 'https://engine.example', fetch });

        expect(Object.prototype.toString.call(client)).toContain(IN_MEMORY_CLIENT_MARKER);
        const signal = AbortSignal.timeout(1000);
        const lists = await Promise.all([
            client.agents.list({}, signal),
            client.runs.list({}, signal),
            client.files.list({}, signal),
            client.triggers.list({}, signal),
            client.integrations.list({}, signal),
        ]);
        for (const list of lists) expect(list.kind === 'ok' && list.data.items.length).toBeGreaterThan(0);
        expect(await client.engine.get(signal)).toMatchObject({
            kind: 'ok',
            data: { name: 'Dev engine', mode: 'local' },
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('shows only what the Reborn engine has on the in-memory client unless asked for the full profile', async () => {
        vi.stubEnv('VITE_ENGINE_API', 'memory');
        const client = await createAppEngineApiClient({ origin: 'https://engine.example', fetch: vi.fn() });
        const engine = await client.engine.get(AbortSignal.timeout(1000));
        expect(engine.kind === 'ok' && engine.data.capabilities.map(({ id }) => id)).toEqual([
            'tasks',
            'files',
            'onboarding',
        ]);
    });
});
