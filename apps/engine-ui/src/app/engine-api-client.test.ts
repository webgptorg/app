import { ENGINE_API_PREFIX, IN_MEMORY_CLIENT_MARKER } from '@ptbk/engine-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppEngineApiClient } from './engine-api-client';

const engineInfo = { name: 'Engine', hostname: 'engine.example', dashboardUrl: null, mode: 'tunnel' };

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
        const fetch = vi.fn<typeof globalThis.fetch>();
        const client = await createAppEngineApiClient({ origin: 'https://engine.example', fetch });

        expect(Object.prototype.toString.call(client)).toContain(IN_MEMORY_CLIENT_MARKER);
        const agents = await client.agents.list({}, AbortSignal.timeout(1000));
        expect(agents.kind === 'ok' && agents.data.items.length).toBeGreaterThan(0);
        expect(fetch).not.toHaveBeenCalled();
    });
});
