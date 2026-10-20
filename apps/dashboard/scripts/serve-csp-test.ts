/**
 * The server behind `test:csp` (Playwright): the built SPA and Worker in workerd through `vite preview`, with the
 * production CSP, the dev config (fake email outbox, in-memory rate limits) and a fresh local D1 on every start.
 * The origin is localhost because WebAuthn accepts it as a secure context and RP ID without TLS.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

import { CSP_TEST_STATE_DIR } from '../vite.config.ts';

export const CSP_TEST_PORT = 4174;
export const CSP_TEST_ORIGIN = `http://localhost:${String(CSP_TEST_PORT)}`;

function main(): void {
    rmSync(CSP_TEST_STATE_DIR, { recursive: true, force: true });
    writeFileSync('dist/ptbk_dashboard/.dev.vars', `DASHBOARD_ORIGIN='${CSP_TEST_ORIGIN}'\n`);
    const migrated = spawnSync(
        'node_modules/.bin/wrangler',
        ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', CSP_TEST_STATE_DIR],
        { stdio: 'inherit', env: { ...process.env, CI: '1' } },
    );
    if (migrated.status !== 0) {
        process.exit(migrated.status ?? 1);
    }
    const server = spawn(
        'node_modules/.bin/vite',
        ['preview', '--mode', 'csp', '--host', 'localhost', '--port', String(CSP_TEST_PORT), '--strictPort'],
        { stdio: 'inherit' },
    );
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => server.kill(signal));
    }
    server.on('exit', (code) => process.exit(code ?? 0));
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
    main();
}
