import { describe, expect, it } from 'vitest';

import type { EngineApiResponse } from './client';
import { ENGINE_API_PREFIX } from './constants';
import { createFetchEngineApiClient } from './fetch-client';
import { createEngineApiHttpHandler } from './http/serve';
import { createInMemoryEngine } from './in-memory-client';
import { engineApiClientSuite } from './testing/client-suite';
import { createInMemoryEngineApiTransport } from './testing/in-memory-transport';

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

const signal = () => AbortSignal.timeout(5_000);

describe('in-memory client', () => {
    engineApiClientSuite((options) => createInMemoryEngine(options));
});

describe('fetch client over the HTTP binding of an in-memory core', () => {
    engineApiClientSuite((options) => {
        const { transport, controller } = createInMemoryEngineApiTransport(options);
        const handler = createEngineApiHttpHandler(transport);
        const client = createFetchEngineApiClient({
            baseUrl: 'https://engine.test',
            fetch: (input, init) => handler(new Request(input, init)),
            timeoutMs: 5_000,
        });
        return { client, controller };
    });
});

describe('fetch client wiring', () => {
    it('calls only the versioned API prefix', async () => {
        const urls: string[] = [];
        const handler = createEngineApiHttpHandler(createInMemoryEngineApiTransport().transport);
        const client = createFetchEngineApiClient({
            baseUrl: 'https://engine.test',
            fetch: (input, init) => {
                const request = new Request(input, init);
                urls.push(new URL(request.url).pathname);
                return handler(request);
            },
            timeoutMs: 1_000,
        });
        ok(await client.agents.list({}, signal()));
        expect(urls).toEqual([`${ENGINE_API_PREFIX}/agents`]);
    });

    it('receives file content as a nosniff attachment', async () => {
        const handler = createEngineApiHttpHandler(createInMemoryEngineApiTransport().transport);
        const responses: Response[] = [];
        const client = createFetchEngineApiClient({
            baseUrl: 'https://engine.test',
            fetch: async (input, init) => {
                const response = await handler(new Request(input, init));
                responses.push(response.clone());
                return response;
            },
            timeoutMs: 1_000,
        });
        const file = ok(
            await client.files.upload({ file: new Blob(['hi']), name: 'a.html', purpose: 'upload' }, signal()),
        );
        ok(await client.files.download(file.id, {}, signal()));
        const download = responses.at(-1);
        expect(download?.headers.get('content-disposition')).toBe('attachment');
        expect(download?.headers.get('x-content-type-options')).toBe('nosniff');
    });
});
