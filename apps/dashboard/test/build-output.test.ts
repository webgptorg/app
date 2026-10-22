import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { budgetsSchema, measureBundles } from '../scripts/bundle-budgets.ts';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const clientDir = join(appDir, 'dist', 'client');

// Runs after `build` (the package `test` script builds first): the strict CSP has no nonces, so the shell must not
// contain anything inline.
describe('built SPA shell', () => {
    it('has no inline script or style', async () => {
        const html = await readFile(join(clientDir, 'index.html'), 'utf8');
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
        expect(scripts.length).toBeGreaterThan(0);
        for (const [, attributes = '', body = ''] of scripts) {
            expect(attributes).toMatch(/\bsrc=/);
            expect(body.trim()).toBe('');
        }
        expect(html).not.toMatch(/<style\b/i);
        expect(html).not.toMatch(/\sstyle=/i);
        expect(html).not.toMatch(/\son[a-z]+=/i);
    });

    it('keeps the Vite manifest out of the public assets', async () => {
        expect(await readFile(join(clientDir, '.assetsignore'), 'utf8')).toMatch(/^\.vite$/m);
    });
});

describe('bundle budgets', () => {
    it('measures the entry and every route chunk', async () => {
        const budgets = budgetsSchema.parse(JSON.parse(await readFile(join(appDir, 'bundle-budgets.json'), 'utf8')));
        const measurements = await measureBundles(clientDir, budgets);
        expect(measurements.filter((m) => m.kind === 'entry')).toHaveLength(1);
        expect(measurements.map((m) => m.key)).toContain('src/client/routes/_app/engines/index.tsx');
        expect(measurements.every((m) => m.gzipBytes > 0)).toBe(true);
    });

    it('fails a chunk that exceeds its budget', async () => {
        const measurements = await measureBundles(clientDir, { entry: 1, routeDefault: 1, routes: {} });
        expect(measurements.every((m) => m.gzipBytes > m.budget)).toBe(true);
    });
});
