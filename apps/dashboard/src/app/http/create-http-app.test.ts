import { describe, expect, it } from 'vitest';

import { createMemoryLogger } from '../../adapters/memory-logger';
import type { Database } from '../../adapters/db/client';
import { createAuthorizer } from '../../domain/authz/authorizer';
import { DASHBOARD_POLICY } from '../../domain/authz/policy';
import { parseConfig } from '../config';
import { createHttpApp } from './create-http-app';

const clock = { nowMs: () => 0 };

function app(options: {
    readonly environment: 'dev' | 'staging';
    readonly viteDevServer: boolean;
    readonly assets?: (request: Request) => Promise<Response>;
}) {
    const config = parseConfig({
        ENVIRONMENT: options.environment,
        DASHBOARD_ORIGIN: 'https://app.ptbk.test',
        ENGINE_DOMAIN: 'engines.ptbk.test',
        RELAYS: [{ relayId: 'relay-1.ptbk.test', region: 'eu-central' }],
        ADAPTERS:
            options.environment === 'dev'
                ? { email: 'fake', billing: 'fake', rateLimit: 'memory' }
                : { email: 'cloudflare', billing: 'stripe', rateLimit: 'workers' },
    });
    const logger = createMemoryLogger();
    const assets = options.assets ?? (() => Promise.resolve(new Response('<!doctype html>')));
    const http = createHttpApp({
        config,
        clock,
        random: { bytes: (n) => new Uint8Array(n) },
        logger,
        // No handler touches D1 yet; the Workers tests run the real binding.
        db: {} as Database,
        authorizer: createAuthorizer({ clock, policy: DASHBOARD_POLICY }),
        assets: { fetch: assets } as unknown as Fetcher,
        viteDevServer: options.viteDevServer,
    });
    return { http, logger };
}

describe('createHttpApp', () => {
    it('relaxes the CSP and drops HSTS only under the Vite dev server in dev', async () => {
        const response = await app({ environment: 'dev', viteDevServer: true }).http.request('/');
        expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self' 'unsafe-inline'");
        expect(response.headers.get('Strict-Transport-Security')).toBeNull();
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('keeps the production policy outside dev even if the dev-server flag is set', async () => {
        const response = await app({ environment: 'staging', viteDevServer: true }).http.request('/');
        expect(response.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');
        expect(response.headers.get('Content-Security-Policy')).toContain("require-trusted-types-for 'script'");
        expect(response.headers.get('Strict-Transport-Security')).not.toBeNull();
    });

    it('answers an unhandled error with a 500 problem and logs no message or content', async () => {
        const { http, logger } = app({
            environment: 'dev',
            viteDevServer: false,
            assets: () => Promise.reject(new Error('prompt: summarise the board minutes')),
        });
        const response = await http.request('/');
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ status: 500, code: 'internal' });
        expect(logger.entries).toEqual([{ level: 'error', event: 'http.unhandled-error', fields: { error: 'Error' } }]);
    });
});
