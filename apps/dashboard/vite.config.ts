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

export default defineConfig(({ mode }) => {
    const https = mode === 'https' ? httpsOptions() : undefined;
    return {
        plugins: [
            paraglideVitePlugin({ project: './project.inlang', outdir: './src/paraglide' }),
            // Options live in tsr.config.json, which `generate` (the router CLI) reads too.
            tanstackRouter(),
            react(),
            tailwindcss(),
            cloudflare(
                https === undefined
                    ? {}
                    : { config: (config) => ({ vars: { ...config.vars, DASHBOARD_ORIGIN: https.origin } }) },
            ),
        ],
        build: { manifest: true },
        ...(https === undefined ? {} : { server: https.server, preview: https.server }),
    };
});
