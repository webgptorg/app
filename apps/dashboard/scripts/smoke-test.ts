/**
 * The deploy pipeline's smoke test (I-03): after `wrangler deploy`, the dashboard answers `/v1/health` for the
 * environment it was deployed to, and `/` serves the SPA shell under the exact production CSP. A new version takes a
 * moment to reach every edge location, so the check repeats until it passes or the time is up.
 *
 *   node scripts/smoke-test.ts --origin https://app.ptbk.io --environment production [--timeout-s 90]
 */
import { parseArgs } from 'node:util';

import { securityHeaders } from '../src/app/http/security-headers.ts';

export interface SmokeTarget {
    readonly origin: string;
    readonly environment: string;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// Empty if the header ever disappears from the source, so the check fails closed.
const EXPECTED_CSP = securityHeaders('production')['Content-Security-Policy'] ?? '';

/** Everything wrong with the deployment, or nothing. */
export async function smokeTest(target: SmokeTarget, fetchFn: Fetch): Promise<readonly string[]> {
    const failures: string[] = [];
    const init: RequestInit = { redirect: 'manual', headers: { 'cache-control': 'no-cache' } };

    const health = await fetchFn(`${target.origin}/v1/health`, init);
    if (health.status !== 200) {
        failures.push(`/v1/health answered ${String(health.status)}`);
    } else {
        const body: unknown = await health.json().catch(() => null);
        const expected = JSON.stringify({ ok: true, environment: target.environment });
        if (JSON.stringify(body) !== expected) {
            failures.push(`/v1/health answered ${JSON.stringify(body)}, expected ${expected}`);
        }
    }

    const shell = await fetchFn(`${target.origin}/`, init);
    const html = shell.status === 200 ? await shell.text() : '';
    if (shell.status !== 200) {
        failures.push(`/ answered ${String(shell.status)}`);
    } else if (!(shell.headers.get('content-type') ?? '').startsWith('text/html')) {
        failures.push(`/ is ${shell.headers.get('content-type') ?? 'without a content type'}, not HTML`);
    } else if (!html.includes('<div id="root"></div>') || !/<script type="module"[^>]* src="\/assets\//.test(html)) {
        failures.push('/ is not the SPA shell');
    }
    if (shell.status === 200 && shell.headers.get('content-security-policy') !== EXPECTED_CSP) {
        failures.push(`/ has CSP ${shell.headers.get('content-security-policy') ?? '(none)'}, not the production CSP`);
    }
    return failures;
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            origin: { type: 'string' },
            environment: { type: 'string' },
            'timeout-s': { type: 'string', default: '90' },
        },
        strict: true,
    });
    const origin = values.origin ?? '';
    const environment = values.environment ?? '';
    const timeoutS = Number(values['timeout-s']);
    if (!/^https:\/\/[a-z0-9.-]+$/.test(origin) || !['staging', 'production'].includes(environment)) {
        throw new Error('usage: smoke-test.ts --origin https://<host> --environment staging|production');
    }
    const deadline = Date.now() + timeoutS * 1000;
    for (;;) {
        const failures = await smokeTest({ origin, environment }, (url, init) =>
            fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
        ).catch((error: unknown) => [`request failed: ${error instanceof Error ? error.name : 'unknown error'}`]);
        if (failures.length === 0) {
            console.log(`✓ ${origin}: /v1/health is ${environment}, / is the SPA shell under the production CSP`);
            return;
        }
        if (Date.now() > deadline) {
            console.error(failures.map((failure) => `✗ ${failure}`).join('\n'));
            process.exitCode = 1;
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
    await main();
}
