import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { ENGINE_API_PREFIX, ENGINE_UI_CSP } from '@ptbk/engine-api';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { z } from 'zod';

import { bundleBudget } from './tooling/bundle-budget.ts';

const appDir = dirname(fileURLToPath(import.meta.url));
const mockEngineUrl = process.env['MOCK_ENGINE_URL'];
// `pack` sets PTBK_UI_VERSION for dry runs (X-03); the version is the only build-specific value in the bundle.
const uiVersion =
    process.env['PTBK_UI_VERSION'] ??
    z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))).version;

export default defineConfig({
    base: '/',
    plugins: [
        // Options live in project.inlang/paraglide.config.js, which `generate` (the Paraglide CLI) reads too.
        paraglideVitePlugin({ project: './project.inlang', outdir: './src/paraglide' }),
        // Options live in tsr.config.json, which `generate` (the router CLI) reads too; code splitting only matters here.
        tanstackRouter({
            // Home is where opening an engine lands, so it ships in the entry: split, it was some twenty small chunks
            // fetched after the entry ran, queued behind HTTP/1.1's six connections (the mock engine's, and any engine's
            // without HTTP/2). It adds about 10 kB gzip to the entry, and routes sharing its parts fetch fewer chunks.
            codeSplittingOptions: { splitBehavior: ({ routeId }) => (routeId === '/' ? [] : undefined) },
        }),
        react(),
        tailwindcss(),
        // The gallery build is never shipped; budgets hold the production bundle, which `test` builds and checks.
        bundleBudget({ appDir, enforce: process.env['CI'] !== undefined && process.env['VITE_UI_GALLERY'] !== '1' }),
    ],
    define: {
        __PTBK_UI_VERSION__: JSON.stringify(uiVersion),
        // A literal, so the minifier drops the gallery route's lazy import entirely unless `test:csp` builds it.
        'import.meta.env.VITE_UI_GALLERY': JSON.stringify(process.env['VITE_UI_GALLERY'] ?? '0'),
    },
    build: {
        // An inlined font or SVG becomes a `data:` URL, which `font-src 'self'` refuses.
        assetsInlineLimit: 0,
        // The polyfill is an inline script; every browser the engine supports has native modulepreload.
        modulePreload: { polyfill: false },
        sourcemap: false,
        // Everything the entry imports statically stays in the entry chunk. Rolldown otherwise splits modules the entry
        // shares with route chunks into common chunks once their share sets differ, and index.html grows modulepreload
        // links next to its one script (U-01 allows exactly one script and one stylesheet).
        // Icons the entry does not use go into one chunk of about 5 kB gzip; otherwise each icon shared by a different
        // set of routes becomes a chunk of a few hundred bytes, and a route fetches several of them.
        rolldownOptions: {
            output: {
                codeSplitting: {
                    groups: [
                        { name: 'index', tags: ['$initial'] },
                        { name: 'icons', test: /[\\/]node_modules[\\/].*lucide-react[\\/]/ },
                    ],
                },
            },
        },
    },
    // The dev server injects inline scripts and styles for HMR, so it gets no CSP; the built bundle is what
    // `test:csp` holds to the engine's policy.
    server: mockEngineUrl === undefined ? {} : { proxy: { [ENGINE_API_PREFIX]: { target: mockEngineUrl } } },
    preview: { headers: { 'Content-Security-Policy': ENGINE_UI_CSP } },
});
