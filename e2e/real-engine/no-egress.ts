// The real-engine dev stack's isolation check (compose.real-engine.yaml): run in the engine's own container, with its
// networks and resolver, before `dev:stack up` starts the engine (and at any time with `docker compose exec`). It
// passes only when nothing outside the stack answers (a public address, a public name through the stack's resolver
// or a public resolver) while the dashboard, both relays and the release store do. Only node: imports and the e2e
// helpers beside it, which the engine's image does not carry: compose mounts them.
import { Resolver, lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { fetchText } from '../src/probe.ts';
import { tcpAttempt } from '../src/tcp-check.ts';

const TIMEOUT_MS = 3_000;

/** Public endpoints that must stay out of reach: anycast DNS and HTTPS, over IPv4 and IPv6. */
export const OUTSIDE_ADDRESSES: readonly (readonly [string, number])[] = [
    ['1.1.1.1', 443],
    ['8.8.8.8', 53],
    ['2606:4700:4700::1111', 443],
];
/** Public names an engine would ask for: a model provider, the npm registry, any site. */
export const OUTSIDE_NAMES: readonly string[] = ['api.openai.com', 'registry.npmjs.org', 'example.com'];
/** What the engine needs, through the stack's resolver and the dev CA. */
export const INSIDE_URLS: readonly string[] = [
    'https://app.ptbk.test:8444/v1/health',
    'https://relay-a.ptbk.test/healthz',
    'https://relay-b.ptbk.test/healthz',
    'https://releases.ptbk.test/conformance/ui/latest.json',
];

export interface EgressProbe {
    readonly target: string;
    readonly expected: 'blocked' | 'reachable';
    /** `reachable` when the connection, lookup or request succeeded; otherwise how it failed. */
    readonly outcome: string;
}

/** Every probe whose outcome is not what isolation requires, as a line for the operator; empty when isolated. */
export function egressFailures(probes: readonly EgressProbe[]): readonly string[] {
    const failures = probes.flatMap((probe) => {
        const reached = probe.outcome === 'reachable';
        if (probe.expected === 'blocked' && reached) return [`${probe.target} is reachable from the engine`];
        if (probe.expected === 'reachable' && !reached) return [`${probe.target} is not reachable (${probe.outcome})`];
        return [];
    });
    const expects = new Set(probes.map((probe) => probe.expected));
    if (!expects.has('blocked') || !expects.has('reachable')) failures.push('the check needs both kinds of probe');
    return failures;
}

function errorCode(error: unknown): string {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return typeof code === 'string' ? code : error instanceof Error ? error.message : 'failed';
}

async function settle(
    target: string,
    expected: EgressProbe['expected'],
    attempt: () => Promise<unknown>,
): Promise<EgressProbe> {
    try {
        await attempt();
        return { target, expected, outcome: 'reachable' };
    } catch (error) {
        return { target, expected, outcome: errorCode(error) };
    }
}

export async function runProbes(ca: string): Promise<readonly EgressProbe[]> {
    const publicResolver = new Resolver({ timeout: TIMEOUT_MS, tries: 1 });
    publicResolver.setServers(['1.1.1.1']);
    return Promise.all([
        ...OUTSIDE_ADDRESSES.map(async ([host, port]): Promise<EgressProbe> => {
            const attempt = await tcpAttempt(host, port, TIMEOUT_MS);
            return {
                target: `tcp ${host.includes(':') ? `[${host}]` : host}:${String(port)}`,
                expected: 'blocked',
                outcome: attempt.outcome === 'connected' ? 'reachable' : attempt.outcome,
            };
        }),
        ...OUTSIDE_NAMES.map((name) => settle(`dns ${name} (stack resolver)`, 'blocked', () => lookup(name))),
        settle('dns example.com (1.1.1.1)', 'blocked', () => publicResolver.resolve4('example.com')),
        ...INSIDE_URLS.map((url) => settle(url, 'reachable', () => fetchText(url, ca, TIMEOUT_MS))),
    ]);
}

async function main(): Promise<void> {
    const { values } = parseArgs({ strict: true, options: { ca: { type: 'string', default: '/pki/ca-cert.pem' } } });
    const probes = await runProbes(readFileSync(values.ca, 'utf8'));
    for (const probe of probes) {
        process.stdout.write(`no-egress: ${probe.expected.padEnd(9)} ${probe.outcome.padEnd(12)} ${probe.target}\n`);
    }
    const failures = egressFailures(probes);
    for (const failure of failures) process.stderr.write(`no-egress: FAIL ${failure}\n`);
    process.stdout.write(`no-egress: ${failures.length === 0 ? 'isolated' : 'NOT isolated'}\n`);
    if (failures.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        process.stderr.write(`no-egress: ${error instanceof Error ? error.message : 'failed'}\n`);
        process.exitCode = 1;
    }
}
