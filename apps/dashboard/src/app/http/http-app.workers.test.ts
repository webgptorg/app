import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'https://app.ptbk.test';

function get(path: string, init?: RequestInit): Promise<Response> {
    return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

function expectSecurityHeaders(response: Response): void {
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain("trusted-types 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(response.headers.get('Strict-Transport-Security')).toMatch(/^max-age=\d+/);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
}

async function expectProblem(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(response.headers.get('Content-Type')).toBe('application/problem+json');
    expect(await response.json()).toEqual({ type: 'about:blank', title: expect.any(String) as string, status, code });
}

describe('dashboard Worker', () => {
    it('answers /v1/health without caching', async () => {
        const response = await get('/v1/health');
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.json()).toEqual({ ok: true, environment: 'dev' });
        expectSecurityHeaders(response);
    });

    it.each(['/', '/engines/x', '/engines/x/settings?tab=billing'])('serves the SPA shell for %s', async (path) => {
        const response = await get(path);
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toMatch(/^text\/html/);
        expect(await response.text()).toContain('<div id="root"></div>');
        expectSecurityHeaders(response);
    });

    it('sets the headers on other static files served through the Worker', async () => {
        const response = await get('/favicon.svg');
        expect(response.status).toBe(200);
        expectSecurityHeaders(response);
    });

    it.each(['/api/nope', '/api', '/v1/nope', '/v1', '/internal/v1/nope', '/webhooks/stripe'])(
        'answers an unknown %s with a 404 problem, never the shell',
        async (path) => {
            const response = await get(path);
            await expectProblem(response, 404, 'not-found');
            expect(response.headers.get('Cache-Control')).toBe('no-store');
            expectSecurityHeaders(response);
        },
    );

    it('serves the registry to relay keys only', async () => {
        const response = await get('/internal/v1/engines/x', { headers: { Authorization: 'Bearer ptbk_rt_short' } });
        await expectProblem(response, 401, 'unauthorized');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expectSecurityHeaders(response);
    });

    it('answers a POST to a page path with a 404 problem', async () => {
        await expectProblem(await get('/engines/x', { method: 'POST' }), 404, 'not-found');
    });

    it('serves the UI API from the shared route table, without caching', async () => {
        const response = await get('/api/environment');
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.json()).toEqual({ environment: 'dev' });
    });
});
