import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IN_MEMORY_CLIENT_MARKER } from '@ptbk/engine-api/in-memory';
import { describe, expect, it } from 'vitest';

import { listRouteFiles } from '../tooling/bundle-budget.ts';
import type { BudgetLine } from '../tooling/bundle-budget.ts';

// Runs after `build` (the package `test` script builds first) and checks exactly what X-03 signs and ships.
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(appDir, 'dist');

/**
 * URL-shaped strings in dependencies that are never fetched: XML namespaces (react-dom), React's error decoder link
 * (text of production error messages), JSON Schema dialects and the IPv6 check's `new URL('http://[…]')` (zod), the
 * router's fallback origin for an opaque `window.origin` (TanStack Router), Tailwind's licence banner, and Paraglide's
 * error documentation link, its base for parsing relative URLs and its origin outside a browser, and the bare scheme
 * GFM prefixes to `www.` autolinks in agent markdown (mdast-util-gfm-autolink-literal). The CSP test
 * proves at runtime that nothing leaves the origin; this list keeps every other URL out of the bundle.
 */
const INERT_URLS = new Set([
    'http://www.w3.org/1998/Math/MathML',
    'http://www.w3.org/1999/xhtml',
    'http://www.w3.org/1999/xlink',
    'http://www.w3.org/2000/svg',
    'http://www.w3.org/XML/1998/namespace',
    'https://react.dev/errors/',
    'http://json-schema.org/draft-04/schema#',
    'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2020-12/schema',
    'http://[',
    'http://localhost',
    'https://tailwindcss.com',
    'https://paraglidejs.com/errors#no-locale-found',
    'http://example.com',
    'http://fallback.com',
    'http://',
]);

/** Rendered only by `@ptbk/ui`'s `Gallery`. */
const GALLERY_MARKER = 'data-ptbk-gallery';

/** A string only `motion` (motion-dom) contains; a test below proves it is really in it. */
const MOTION_MARKERS = ['data-layout-id'];

const ABSOLUTE_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`()<>\\,;{}$]*/gi;
const PROTOCOL_RELATIVE_URL = /["'`(]\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/gi;
const DATA_URL = /\bdata:(?:[a-z]+\/[a-z0-9.+-]+)?(?:;[a-z0-9=.+-]+)*,/gi;

async function emittedFiles(): Promise<{ path: string; text: string }[]> {
    const paths = (await readdir(distDir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(distDir.length + 1))
        .sort();
    return Promise.all(paths.map(async (path) => ({ path, text: await readFile(join(distDir, path), 'utf8') })));
}

describe('dist/', () => {
    it('holds index.html and content-hashed assets only', async () => {
        const paths = (await emittedFiles()).map((file) => file.path);
        expect(paths).toContain('index.html');
        expect(paths.filter((path) => path !== 'index.html')).not.toEqual([]);
        for (const path of paths.filter((candidate) => candidate !== 'index.html')) {
            expect(path).toMatch(/^assets\/[\w-]+-[\w-]{8}\.(js|css|woff2|svg|png|webp)$/);
        }
    });

    it('serves an index.html with one module script, one stylesheet and nothing inline', async () => {
        const html = await readFile(join(distDir, 'index.html'), 'utf8');
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
        expect(scripts).toHaveLength(1);
        const [, attributes = '', body = ''] = scripts[0] ?? [];
        expect(attributes).toMatch(/\btype="module"/);
        expect(attributes).toMatch(/\bsrc="\/assets\/[^"]+\.js"/);
        expect(body.trim()).toBe('');

        const links = [...html.matchAll(/<link\b([^>]*)>/gi)].map(([, linkAttributes = '']) => linkAttributes);
        expect(links).toHaveLength(1);
        expect(links[0]).toMatch(/\brel="stylesheet"/);
        expect(links[0]).toMatch(/\bhref="\/assets\/[^"]+\.css"/);

        expect(html).not.toMatch(/<style\b/i);
        expect(html).not.toMatch(/\sstyle=/i);
        expect(html).not.toMatch(/\son[a-z]+=/i);
        expect(html).not.toMatch(/<base\b/i);
    });

    it('contains no data: URL and no external URL', async () => {
        const found: string[] = [];
        for (const { path, text } of await emittedFiles()) {
            for (const [match] of text.matchAll(DATA_URL)) found.push(`${path}: ${match}`);
            for (const [match] of text.matchAll(PROTOCOL_RELATIVE_URL)) found.push(`${path}: ${match}`);
            for (const [match] of text.matchAll(ABSOLUTE_URL)) {
                if (!INERT_URLS.has(match)) found.push(`${path}: ${match}`);
            }
        }
        expect(found).toEqual([]);
    });

    it('does not ship the in-memory engine API client', async () => {
        for (const { path, text } of await emittedFiles()) {
            expect(text.includes(IN_MEMORY_CLIENT_MARKER), path).toBe(false);
        }
    });

    it('does not ship the component gallery (only the test:csp build mounts it)', async () => {
        for (const { path, text } of await emittedFiles()) {
            expect(text.includes(GALLERY_MARKER), path).toBe(false);
        }
    });

    it('keeps `motion` out of the entry chunk', async () => {
        const report = JSON.parse(
            await readFile(join(appDir, 'reports', 'bundle-budget.json'), 'utf8'),
        ) as BudgetLine[];
        const entry = report.find((line) => line.kind === 'entry');
        if (entry === undefined) throw new Error('no entry chunk in the budget report');
        const code = await readFile(join(distDir, entry.name), 'utf8');
        for (const marker of MOTION_MARKERS) expect(code.includes(marker), marker).toBe(false);
    });

    it('has a bundle budget report outside dist/ that lists every route within budget', async () => {
        const report = JSON.parse(
            await readFile(join(appDir, 'reports', 'bundle-budget.json'), 'utf8'),
        ) as BudgetLine[];
        const routes = report.filter((line) => line.kind === 'route').map((line) => line.name);
        expect(routes).toEqual(await listRouteFiles(join(appDir, 'src', 'routes')));
        expect(report.filter((line) => line.kind === 'entry')).toHaveLength(1);
        expect(report.filter((line) => line.gzipBytes > line.budget)).toEqual([]);
    });
});

describe('the dist scan', () => {
    it('looks for markers that motion really contains', async () => {
        const require = createRequire(join(appDir, '..', '..', 'packages', 'ui', 'package.json'));
        const motionDir = dirname(require.resolve('motion/package.json'));
        const bundled = await readFile(join(motionDir, 'dist', 'motion.dev.js'), 'utf8');
        for (const marker of MOTION_MARKERS) expect(bundled.includes(marker), marker).toBe(true);
    });

    it.each([
        ['a data: URL', 'url(data:image/png;base64,AAAA)', DATA_URL],
        ['a bare data: URL', '"data:,hello"', DATA_URL],
        ['an external URL', 'fetch("https://cdn.example/x.js")', ABSOLUTE_URL],
        ['a protocol-relative URL', 'url(//fonts.example/a.woff2)', PROTOCOL_RELATIVE_URL],
    ])('finds %s', (_, text, pattern) => {
        expect(text.match(pattern)).not.toBeNull();
    });

    it('ignores object keys named data', () => {
        expect('{success:!0,data:a.value}'.match(DATA_URL)).toBeNull();
    });
});
