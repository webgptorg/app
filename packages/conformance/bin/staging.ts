import { parseArgs } from 'node:util';

import { EngineId } from '@ptbk/engine-api';

import type { StagingPorts, StagingReport } from '../node/index';
import { runStagingCheck } from '../node/index';

export const STAGING_USAGE = `Usage: ptbk-conformance staging --engine https://<engineId>.engines.ptbk.link [options]

Checks from outside what the platform promises for an engine on live staging: DNS through the relay, a public
certificate, the gateway, the security headers, and the UI release it serves. It talks to live hosts, read-only
(DNS, TLS handshakes, GET), and is never part of CI.

Options:
  --engine <url>              The engine's https origin; its first DNS label is the engine ID (required)
  --relay <hostname>          A relay the engine hostname must resolve to (repeatable; default relay-fsn.ptbk.link)
  --release-url <url>         The UI release store, https with a trailing slash (default https://ui.ptbk.link/)
  --timeout-ms <n>            Per DNS lookup, TLS handshake and request (default 15000)
  --json                      Print one JSON object instead of lines
  PTBK_CONFORMANCE_OWNER_COOKIE=<name=value>
                              An owner session cookie for the checks that need one; without it they skip

Exit code 0 only when no check failed (skips do not fail); 1 when one did; 2 for a usage error.`;

const DEFAULT_RELAY = 'relay-fsn.ptbk.link';
const DEFAULT_RELEASE_URL = 'https://ui.ptbk.link/';
const DEFAULT_TIMEOUT_MS = 15_000;
/** `name=value` with a cookie-name token and a value without separators or whitespace. */
const COOKIE = /^[!#$%&'*+.^`|~0-9A-Za-z_-]+=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export interface StagingCliIo {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly ports: StagingPorts;
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
    readonly signal: AbortSignal;
}

class UsageError extends Error {}

/** `ptbk-conformance staging …`: resolves with the exit code. */
export async function runStagingCli(argv: readonly string[], io: StagingCliIo): Promise<number> {
    let parsed: ReturnType<typeof parse>;
    try {
        parsed = parse(argv, io.env);
    } catch (error) {
        if (!(error instanceof UsageError) && !isParseArgsError(error)) throw error;
        io.stderr(`${(error as Error).message}\n\n${STAGING_USAGE}\n`);
        return 2;
    }
    if (parsed === 'help') {
        io.stdout(`${STAGING_USAGE}\n`);
        return 0;
    }
    const report = await runStagingCheck({ ...parsed.options, signal: io.signal }, io.ports);
    io.stdout(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    return report.ok ? 0 : 1;
}

function parse(argv: readonly string[], env: StagingCliIo['env']) {
    const { values } = parseArgs({
        args: [...argv],
        strict: true,
        allowPositionals: false,
        options: {
            engine: { type: 'string' },
            relay: { type: 'string', multiple: true },
            'release-url': { type: 'string', default: DEFAULT_RELEASE_URL },
            'timeout-ms': { type: 'string', default: String(DEFAULT_TIMEOUT_MS) },
            json: { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
    });
    if (values.help) return 'help' as const;
    const engine = engineUrl(values.engine);
    const engineId = EngineId.safeParse(engine.hostname.split('.')[0]);
    if (!engineId.success) throw new UsageError('--engine: the first DNS label of the hostname must be the engine ID');
    const relays = values.relay ?? [DEFAULT_RELAY];
    for (const relay of relays) {
        if (!HOSTNAME.test(relay)) throw new UsageError(`--relay ${relay} is not a hostname`);
    }
    const releaseUrl = httpsUrl(values['release-url'], '--release-url');
    if (!releaseUrl.pathname.endsWith('/') || releaseUrl.search !== '' || releaseUrl.hash !== '') {
        throw new UsageError('--release-url must end with / and have no query or fragment');
    }
    const timeout = values['timeout-ms'];
    const timeoutMs = /^\d{1,7}$/.test(timeout) ? Number(timeout) : 0;
    if (timeoutMs < 1 || timeoutMs > 600_000) throw new UsageError('--timeout-ms must be an integer from 1 to 600000');
    const cookie = env['PTBK_CONFORMANCE_OWNER_COOKIE'];
    const ownerCookie = cookie === undefined || cookie === '' ? null : cookie;
    // The value is a credential: the message names the variable only.
    if (ownerCookie !== null && !COOKIE.test(ownerCookie)) {
        throw new UsageError('PTBK_CONFORMANCE_OWNER_COOKIE must be one cookie as name=value');
    }
    return {
        json: values.json,
        options: { engine, engineId: engineId.data, relays, releaseUrl, ownerCookie, timeoutMs },
    };
}

function httpsUrl(value: string | undefined, flag: string): URL {
    if (value === undefined) throw new UsageError(`${flag} is required`);
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new UsageError(`${flag} is not a URL`);
    }
    if (url.protocol !== 'https:') throw new UsageError(`${flag} must be https`);
    return url;
}

function engineUrl(value: string | undefined): URL {
    const url = httpsUrl(value, '--engine');
    if (url.port !== '' || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '') {
        throw new UsageError('--engine must be an origin: https://<engineId>.<engine domain>, no port, path or query');
    }
    return new URL(url.origin);
}

function isParseArgsError(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_');
}

export function formatReport(report: StagingReport): string {
    const lines = [`Staging check of ${report.engine}`];
    for (const check of report.checks) {
        lines.push(`${check.status.toUpperCase().padEnd(4)}  ${check.id}  ${check.detail}`);
        if (check.fix !== undefined) lines.push(`      fix: ${check.fix}`);
    }
    const failed = report.checks.filter(({ status }) => status === 'fail').length;
    const skipped = report.checks.filter(({ status }) => status === 'skip').length;
    const passed = report.checks.length - failed - skipped;
    lines.push(`${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped`);
    return `${lines.join('\n')}\n`;
}
