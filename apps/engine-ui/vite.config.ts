import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { ENGINE_API_PREFIX, ENGINE_UI_CSP } from '@ptbk/engine-api';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { bundleBudget } from './tooling/bundle-budget.ts';

const appDir = dirname(fileURLToPath(import.meta.url));
const mockEngineUrl = process.env['MOCK_ENGINE_URL'];

export default defineConfig({
    base: '/',
    plugins: [
        // Options live in project.inlang/paraglide.config.js, which `generate` (the Paraglide CLI) reads too.
        paraglideVitePlugin({ project: './project.inlang', outdir: './src/paraglide' }),
        // Options live in tsr.config.json, which `generate` (the router CLI) reads too.
        tanstackRouter(),
        react(),
        tailwindcss(),
        bundleBudget({ appDir, enforce: process.env['CI'] !== undefined }),
    ],
    build: {
        // An inlined font or SVG becomes a `data:` URL, which `font-src 'self'` refuses.
        assetsInlineLimit: 0,
        // The polyfill is an inline script; every browser the engine supports has native modulepreload.
        modulePreload: { polyfill: false },
        sourcemap: false,
    },
    // The dev server injects inline scripts and styles for HMR, so it gets no CSP; the built bundle is what
    // `test:csp` holds to the engine's policy.
    server: mockEngineUrl === undefined ? {} : { proxy: { [ENGINE_API_PREFIX]: { target: mockEngineUrl } } },
    preview: { headers: { 'Content-Security-Policy': ENGINE_UI_CSP } },
});
