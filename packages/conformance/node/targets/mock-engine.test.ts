import { describe, expect, it } from 'vitest';

import type { EngineProcess } from '../harness/engine-process';
import { createMockEngineTargetFactory } from './mock-engine';

describe('createMockEngineTargetFactory', () => {
    it('gives each engine a control port and signs in through it, with the relay fetch for the API', async () => {
        const factory = createMockEngineTargetFactory();
        const env = await factory.engineEnv();
        expect(env).toMatchObject({ MOCK_CONTROL: 'enabled', MOCK_CONTROL_HOST: '127.0.0.1' });
        expect(Number(env['MOCK_CONTROL_PORT'])).toBeGreaterThan(0);
        const relayFetch: typeof fetch = () => Promise.resolve(new Response(null, { status: 418 }));
        const engine = { env } as unknown as EngineProcess;
        const target = factory.target(engine, { baseUrl: new URL('https://e.engine.localhost'), fetch: relayFetch });
        expect(target.fetch).toBe(relayFetch);
        expect(target.baseUrl.href).toBe('https://e.engine.localhost/');
        await expect(target.session({ kind: 'owner' })).rejects.toThrow();
    });

    it('refuses an engine started without the control listener', () => {
        const factory = createMockEngineTargetFactory();
        const engine = { env: {} } as unknown as EngineProcess;
        expect(() => factory.target(engine, { baseUrl: new URL('https://e.test'), fetch })).toThrow(/control listener/);
    });
});
