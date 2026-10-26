import { describe, expect, it } from 'vitest';

import { securityHeaders } from '../src/app/http/security-headers.ts';
import { smokeTest, type Fetch } from './smoke-test.ts';

const CSP = securityHeaders('production')['Content-Security-Policy'] ?? '';
const SHELL =
    '<!doctype html><div id="root"></div><script type="module" crossorigin src="/assets/index-a1.js"></script>';

function site(overrides: { health?: Response; shell?: Response } = {}): Fetch {
    return (url) =>
        Promise.resolve(
            url.endsWith('/v1/health')
                ? (overrides.health ?? Response.json({ ok: true, environment: 'staging' }))
                : (overrides.shell ??
                      new Response(SHELL, {
                          headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP },
                      })),
        );
}

const target = { origin: 'https://app.staging.example', environment: 'staging' };

describe('smokeTest', () => {
    it('passes a healthy deployment of the expected environment', async () => {
        await expect(smokeTest(target, site())).resolves.toEqual([]);
    });

    it('fails when the health check is down or reports another environment', async () => {
        await expect(smokeTest(target, site({ health: new Response(null, { status: 503 }) }))).resolves.toEqual([
            '/v1/health answered 503',
        ]);
        const production = Response.json({ ok: true, environment: 'production' });
        await expect(smokeTest(target, site({ health: production }))).resolves.toEqual([
            '/v1/health answered {"ok":true,"environment":"production"}, expected {"ok":true,"environment":"staging"}',
        ]);
    });

    it('fails without the SPA shell', async () => {
        const redirect = new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } });
        await expect(smokeTest(target, site({ shell: redirect }))).resolves.toEqual(['/ answered 302']);
        const json = Response.json({}, { headers: { 'content-security-policy': CSP } });
        await expect(smokeTest(target, site({ shell: json }))).resolves.toEqual(['/ is application/json, not HTML']);
        const other = new Response('<p>parked</p>', {
            headers: { 'content-type': 'text/html', 'content-security-policy': CSP },
        });
        await expect(smokeTest(target, site({ shell: other }))).resolves.toEqual(['/ is not the SPA shell']);
    });

    it('fails when the CSP is missing or not the production one', async () => {
        const missing = new Response(SHELL, { headers: { 'content-type': 'text/html' } });
        await expect(smokeTest(target, site({ shell: missing }))).resolves.toEqual([
            '/ has CSP (none), not the production CSP',
        ]);
        const relaxed = new Response(SHELL, {
            headers: { 'content-type': 'text/html', 'content-security-policy': `${CSP}; script-src 'unsafe-inline'` },
        });
        await expect(smokeTest(target, site({ shell: relaxed }))).resolves.toHaveLength(1);
    });
});
