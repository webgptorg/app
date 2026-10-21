import { readFileSync } from 'node:fs';

import { cloudflare } from '@cloudflare/vite-plugin';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type PreviewOptions } from 'vite';

/**
 * `--mode https` (the `dev:https` script and the dev container): passkeys need a secure context on a real hostname.
 * The certificate and key come in by path, so the e2e dev CA or a locally generated pair both work, and the Worker's
 * `DASHBOARD_ORIGIN` (and with it the WebAuthn rpID) follows the served origin.
 */
function httpsOptions() {
    const { DASHBOARD_ORIGIN: origin, DASHBOARD_TLS_CERT: cert, DASHBOARD_TLS_KEY: key } = process.env;
    if (origin === undefined || cert === undefined || key === undefined) {
        throw new Error('--mode https needs DASHBOARD_ORIGIN, DASHBOARD_TLS_CERT and DASHBOARD_TLS_KEY');
    }
    if (process.env['CLOUDFLARE_ENV'] !== undefined) {
        throw new Error('--mode https is for local development only; it never builds a deployable environment');
    }
    const url = new URL(origin);
    if (url.protocol !== 'https:') {
        throw new Error('DASHBOARD_ORIGIN must be https in --mode https');
    }
    const server: PreviewOptions = {
        https: { cert: readFileSync(cert), key: readFileSync(key) },
        host: true,
        port: url.port === '' ? 443 : Number(url.port),
        strictPort: true,
        allowedHosts: [url.hostname],
    };
    return { origin: url.origin, server };
}

/** `--mode csp` (Playwright's `test:csp` server): its own local D1, so the suite never touches the developer's data. */
export const CSP_TEST_STATE_DIR = '.wrangler/csp-test-state';

function cloudflareOptions(mode: string, https: ReturnType<typeof httpsOptions> | undefined) {
    if (https !== undefined) {
        return {
            config: (config: { vars?: Record<string, unknown> }) => ({
                vars: { ...config.vars, DASHBOARD_ORIGIN: https.origin },
            }),
        };
    }
    return mode === 'csp' ? { persistState: { path: CSP_TEST_STATE_DIR } } : {};
}

/**
 * zod probes `new Function` when it builds an object schema unless `jitless` is set first, and under the strict CSP that
 * probe is a reported Trusted Types violation. `zod-jitless.ts` sets it, but a chunk is evaluated before the module
 * that imports it: if zod shared a chunk with modules that define schemas, they would be built before the setting ran.
 * One chunk holding only zod and that module keeps the order whatever else the bundler groups.
 */
const ZOD_CHUNK = { name: 'zod', test: /\/node_modules\/zod\/|\/src\/client\/zod-jitless\.ts$/ };

export default defineConfig(({ mode }) => {
    const https = mode === 'https' ? httpsOptions() : undefined;
    return {
        plugins: [
            paraglideVitePlugin({ project: './project.inlang', outdir: './src/paraglide' }),
            // Options live in tsr.config.json, which `generate` (the router CLI) reads too.
            tanstackRouter(),
            react(),
            tailwindcss(),
            cloudflare(cloudflareOptions(mode, https)),
        ],
        build: { manifest: true },
        environments: {
            client: { build: { rolldownOptions: { output: { codeSplitting: { groups: [ZOD_CHUNK] } } } } },
        },
        ...(https === undefined ? {} : { server: https.server, preview: https.server }),
    };
});
