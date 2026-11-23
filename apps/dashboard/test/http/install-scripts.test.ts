import { describe, expect, it } from 'vitest';

import type { EngineInstallReleaseSource } from '../../src/domain/registration/engine-install-release-source';
import { INSTALL_SCRIPT_PATHS } from '../../src/domain/registration/installation-options';
import { createAuthHarness, ORIGIN } from '../../src/testing/auth-harness';
import { TEST_ENGINE_INSTALLATION } from '../../src/testing/install-fixtures';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';

const PATHS = Object.values(INSTALL_SCRIPT_PATHS);

describe('install scripts over HTTP', () => {
    it.each(PATHS)('serves %s as uncached plain text with the release selected now', async (path) => {
        let lookups = 0;
        const installReleases: EngineInstallReleaseSource = {
            current(fallback) {
                lookups++;
                return Promise.resolve({ ...fallback, version: '0.119.0-125', windowsSha256: 'b'.repeat(64) });
            },
        };
        const harness = createAuthHarness({
            store: createMemoryAuthStore(),
            billing: 'off',
            engineInstallation: TEST_ENGINE_INSTALLATION,
            installReleases,
        });
        for (const method of ['GET', 'HEAD']) {
            const response = await harness.http.request(`${ORIGIN}${path}`, { method });
            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
            expect(response.headers.get('Cache-Control')).toBe('no-store');
            expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
            const text = await response.text();
            if (method === 'HEAD') continue;
            expect(text).toContain("'0.119.0-125'");
            expect(text).toContain(`${ORIGIN}/link#`);
            expect(text).not.toContain('<!doctype html>');
        }
        expect(lookups).toBe(2);
    });

    it.each(PATHS)('answers %s with a problem, never the SPA shell, without installation metadata', async (path) => {
        const harness = createAuthHarness({ store: createMemoryAuthStore(), billing: 'off' });
        const response = await harness.http.request(`${ORIGIN}${path}`);
        expect(response.status).toBe(404);
        expect(response.headers.get('Content-Type')).toBe('application/problem+json');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it.each(PATHS)('answers paths under %s with a problem, never the SPA shell', async (path) => {
        const harness = createAuthHarness({
            store: createMemoryAuthStore(),
            billing: 'off',
            engineInstallation: TEST_ENGINE_INSTALLATION,
        });
        for (const suffix of ['/', '/x']) {
            const response = await harness.http.request(`${ORIGIN}${path}${suffix}`);
            expect(response.status).toBe(404);
            expect(response.headers.get('Content-Type')).toBe('application/problem+json');
        }
    });

    it('takes no other method', async () => {
        const harness = createAuthHarness({
            store: createMemoryAuthStore(),
            billing: 'off',
            engineInstallation: TEST_ENGINE_INSTALLATION,
        });
        const response = await harness.http.request(`${ORIGIN}/install.sh`, { method: 'POST' });
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain('<!doctype html>');
    });
});
