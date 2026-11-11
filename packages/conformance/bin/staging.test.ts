import { describe, expect, it } from 'vitest';

import type { WorldOptions } from '../node/testing/staging-world';
import { ENGINE_HOST, OWNER_COOKIE, createStagingWorld } from '../node/testing/staging-world';
import { USAGE, runCli } from './cli';
import type { StagingCliIo } from './staging';
import { STAGING_USAGE, runStagingCli } from './staging';

const ENGINE = `https://${ENGINE_HOST}`;

function io(world: WorldOptions = {}, env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const streams: StagingCliIo = {
        env,
        ports: createStagingWorld(world).ports,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        signal: new AbortController().signal,
    };
    return { streams, out, err };
}

describe('runStagingCli', () => {
    it('prints one line per check and exits 0 when none failed', async () => {
        const { streams, out } = io({}, { PTBK_CONFORMANCE_OWNER_COOKIE: OWNER_COOKIE });
        expect(await runStagingCli(['--engine', ENGINE], streams)).toBe(0);
        const text = out.join('');
        expect(text).toContain("PASS  staging.tls.public-certificate  Let's Encrypt E6, expires 2027-02-01");
        expect(text).toContain('9 passed, 0 failed, 0 skipped');
        expect(text).not.toContain(OWNER_COOKIE.split('=')[1]);
    });

    it('prints fix lines and exits 1 when a check failed', async () => {
        const { streams, out } = io({ tls: { kind: 'failed', code: 'ECONNRESET' } });
        expect(await runStagingCli(['--engine', `${ENGINE}/`], streams)).toBe(1);
        const text = out.join('');
        expect(text).toMatch(
            /FAIL {2}staging\.tls\.public-certificate {2}no TLS handshake .*\n {6}fix: the relay has no tunnel/,
        );
        expect(text).toMatch(/SKIP {2}staging\.gateway\.sign-in/);
    });

    it('prints one JSON object with --json', async () => {
        const { streams, out } = io();
        const relays = ['--relay', 'relay-fsn.ptbk.link', '--relay', 'relay-hel.ptbk.link'];
        const argv = [
            '--engine',
            ENGINE,
            '--json',
            '--timeout-ms',
            '2000',
            '--release-url',
            'https://ui.ptbk.link/',
            ...relays,
        ];
        expect(await runStagingCli(argv, streams)).toBe(1);
        const report = JSON.parse(out.join('')) as {
            engine: string;
            ok: boolean;
            checks: { id: string; status: string }[];
        };
        expect(report.engine).toBe(ENGINE);
        expect(report.ok).toBe(false);
        expect(report.checks.find(({ id }) => id === 'staging.dns.via-relay')?.status).toBe('fail');
    });

    it('prints usage for --help', async () => {
        const { streams, out } = io();
        expect(await runStagingCli(['--help'], streams)).toBe(0);
        expect(out.join('')).toBe(`${STAGING_USAGE}\n`);
    });

    it.each([
        [[], '--engine is required'],
        [['--engine', 'not a url'], '--engine is not a URL'],
        [['--engine', `http://${ENGINE_HOST}`], '--engine must be https'],
        [['--engine', `${ENGINE}/path`], '--engine must be an origin'],
        [['--engine', `${ENGINE}:8443`], '--engine must be an origin'],
        [['--engine', 'https://engine.test'], 'the first DNS label of the hostname must be the engine ID'],
        [['--engine', ENGINE, '--relay', 'not a host'], '--relay not a host is not a hostname'],
        [['--engine', ENGINE, '--release-url', 'https://ui.ptbk.link/x'], '--release-url must end with /'],
        [['--engine', ENGINE, '--release-url', 'https://ui.ptbk.link/?a'], '--release-url must end with /'],
        [['--engine', ENGINE, '--timeout-ms', '0'], '--timeout-ms must be an integer'],
        [['--engine', ENGINE, '--timeout-ms', 'soon'], '--timeout-ms must be an integer'],
        [['--engine', ENGINE, '--unknown'], "Unknown option '--unknown'"],
    ])('refuses %j with exit code 2', async (argv, message) => {
        const { streams, err } = io();
        expect(await runStagingCli(argv, streams)).toBe(2);
        expect(err.join('')).toContain(message);
    });

    it('refuses a malformed cookie without printing it', async () => {
        const { streams, err } = io({}, { PTBK_CONFORMANCE_OWNER_COOKIE: 'secret-without-name' });
        expect(await runStagingCli(['--engine', ENGINE], streams)).toBe(2);
        expect(err.join('')).toContain('PTBK_CONFORMANCE_OWNER_COOKIE must be one cookie as name=value');
        expect(err.join('')).not.toContain('secret-without-name');
    });

    it('rethrows what is not a usage error', async () => {
        const { streams } = io();
        const broken = {
            ...streams,
            env: new Proxy(
                {},
                {
                    get: () => {
                        throw new RangeError('boom');
                    },
                },
            ),
        };
        await expect(runStagingCli(['--engine', ENGINE], broken)).rejects.toThrow('boom');
    });
});

describe('ptbk-conformance staging', () => {
    it('is dispatched by the main CLI and named in its usage', async () => {
        expect(USAGE).toContain('ptbk-conformance staging --engine');
        const out: string[] = [];
        const code = await runCli(['staging', '--help'], {
            env: {},
            fetch: () => Promise.reject(new Error('no network')),
            stdout: (text) => out.push(text),
            stderr: () => undefined,
            signal: new AbortController().signal,
        });
        expect(code).toBe(0);
        expect(out.join('')).toBe(`${STAGING_USAGE}\n`);
    });
});
