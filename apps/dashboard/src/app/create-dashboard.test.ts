import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../worker';
import { createDashboard } from './create-dashboard';

const vars = {
    ENVIRONMENT: 'dev',
    DASHBOARD_ORIGIN: 'http://localhost:5173',
    ENGINE_DOMAIN: 'engines.ptbk.test',
    RELAYS: [{ relayId: 'relay.ptbk.test', region: 'local' }],
    ADAPTERS: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
};

class FakeBinding {
    fetch(): Promise<Response> {
        return Promise.resolve(new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }));
    }
}

function env(overrides: Record<string, unknown> = {}): Env {
    return { ...vars, DB: new FakeBinding(), ASSETS: new FakeBinding(), ...overrides } as unknown as Env;
}

const ctx = {} as ExecutionContext;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('createDashboard', () => {
    it('serves requests once the configuration parses', async () => {
        const response = await createDashboard(env(), { viteDevServer: false }).fetch(
            new Request('https://app.ptbk.test/v1/health'),
        );
        expect(await response.json()).toEqual({ ok: true, environment: 'dev' });
    });

    it.each([
        ['an unknown var', { DEBUG: 'true' }],
        ['an unknown value', { ENVIRONMENT: 'qa' }],
        ['a fake adapter outside dev', { ENVIRONMENT: 'production', DASHBOARD_ORIGIN: 'https://app.ptbk.io' }],
    ])('fails closed on %s: every request is a 503 problem with production headers', async (_, overrides) => {
        const errors: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((line: string) => errors.push(line));
        const dashboard = createDashboard(env(overrides), { viteDevServer: true });
        for (const path of ['/', '/v1/health', '/api/environment']) {
            const response = await dashboard.fetch(new Request(`https://app.ptbk.test${path}`));
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({ status: 503, code: 'misconfigured' });
            expect(response.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');
        }
        expect(errors).toHaveLength(1);
        expect(JSON.parse(errors[0] ?? '{}')).toMatchObject({ event: 'config.invalid' });
        expect(errors[0]).not.toMatch(/qa|app\.ptbk\.io|true/);
    });

    it('rethrows anything that is not a configuration error', () => {
        const hostile = new Proxy(
            {},
            {
                ownKeys: () => {
                    throw new TypeError('broken binding');
                },
            },
        );
        expect(() => createDashboard(hostile as Env, { viteDevServer: false })).toThrow(TypeError);
    });
});

describe('Worker entry', () => {
    it('hands every request to the composition root', async () => {
        const response = await worker.fetch(new Request('https://app.ptbk.test/v1/health'), env(), ctx);
        expect(response.status).toBe(200);
    });
});
