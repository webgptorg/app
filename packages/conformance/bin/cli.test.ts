import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionSubject } from '../src/index';
import type { FakeEngine, FakeEngineOptions } from '../src/testing/fake-engine';
import { createFakeEngine } from '../src/testing/fake-engine';
import { freeLoopbackPort } from '../node/harness/loopback';
import { SELF_TEST_HEARTBEAT_INTERVAL_S, fakeEngineCommand, mockEngineCommand } from '../node/testing/engines';
import type { CliIo } from './cli';
import { USAGE, runCli } from './cli';

const BUNDLE = fileURLToPath(new URL('../dist/ptbk-conformance.js', import.meta.url));

/** A fixed control port for the mock's conformance-session command; engines the harness starts run one at a time. */
const MOCK_CONTROL_ENV = `MOCK_CONTROL=enabled MOCK_CONTROL_HOST=127.0.0.1 MOCK_CONTROL_PORT=${String(await freeLoopbackPort())}`;

/** Fast checks, one per suite; `engine-api.engine.id-matches-key` passes only if the harness names the key. */
const ONE_CHECK_PER_SUITE = [
    'engine-api.engine.id-matches-key',
    'registration.request.signature-verifies',
    'heartbeat.signature.verifies',
    'tunnel.dial.websocket-upgrade',
    'ui-loader.install.pinned-valid',
];
const GATEWAY_CHECK = 'engine-api.gateway.cross-site-refused';
const run = promisify(execFile);

/** Serves a fake engine on plain HTTP, plus `/__session` so a separate process can sign in. */
async function serve(engine: FakeEngine): Promise<{ readonly server: Server; readonly port: number }> {
    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
        void (async () => {
            const body = ['GET', 'HEAD'].includes(incoming.method ?? 'GET')
                ? undefined
                : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
            const request = new Request(new URL(incoming.url ?? '/', engine.target.baseUrl), {
                method: incoming.method ?? 'GET',
                headers: incoming.headers as Record<string, string>,
                ...(body === undefined ? {} : { body, duplex: 'half' }),
            });
            const response =
                new URL(request.url).pathname === '/__session'
                    ? Response.json(await engine.target.session((await request.json()) as SessionSubject))
                    : await engine.handle(request);
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            if (response.body === null) outgoing.end();
            else Readable.fromWeb(response.body as never).pipe(outgoing);
        })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as AddressInfo).port };
}

const TARGET_MODULE = `
export function createConformanceTarget({ baseUrl, fetch }) {
    const local = (url) => new URL(new URL(url).pathname + new URL(url).search, process.env.FAKE_ENGINE);
    return {
        baseUrl,
        fetch: (input, init) => {
            const request = new Request(input, init);
            return fetch(new Request(local(request.url), request));
        },
        async session(subject) {
            const response = await fetch(local(new URL('/__session', baseUrl)), { method: 'POST', body: JSON.stringify(subject) });
            return response.json();
        },
    };
}
`;

let directory: string;
const servers: Server[] = [];

beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ptbk-conformance-'));
    await writeFile(join(directory, 'target.mjs'), TARGET_MODULE);
    await writeFile(join(directory, 'empty.mjs'), 'export const nothing = 1;\n');
});

afterAll(async () => {
    for (const server of servers) server.close();
    await rm(directory, { recursive: true, force: true });
});

async function engineProcess(options: FakeEngineOptions, args: readonly string[], env: Record<string, string> = {}) {
    const engine = await createFakeEngine(options);
    const { server, port } = await serve(engine);
    servers.push(server);
    try {
        const result = await run(process.execPath, [BUNDLE, '--base-url', engine.target.baseUrl.href, ...args], {
            env: { PATH: process.env['PATH'] ?? '', FAKE_ENGINE: `http://127.0.0.1:${String(port)}`, ...env },
        });
        return { code: 0, ...result };
    } catch (error) {
        const failed = error as { code: number; stdout: string; stderr: string };
        return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
}

describe('the bundled CLI under Node', () => {
    it('passes a correct engine through a target module and writes JUnit', async () => {
        const out = join(directory, 'pass.xml');
        const result = await engineProcess({}, [
            '--target-module',
            join(directory, 'target.mjs'),
            '--filter',
            'engine-api.agents.',
            '--report',
            'junit',
            '--out',
            out,
        ]);
        expect(result.stderr).toContain('4 passed, 0 failed');
        expect(result.code).toBe(0);
        expect(await readFile(out, 'utf8')).toContain(
            '<testcase classname="engine-api" name="engine-api.agents.create-and-list"',
        );
    });

    it('exits non-zero when a check fails', async () => {
        const result = await engineProcess({ defect: 'missing-auth' }, [
            '--target-module',
            join(directory, 'target.mjs'),
            '--filter',
            'engine-api.auth.',
        ]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('FAIL  engine-api.auth.unauthenticated-401');
        expect(JSON.parse(result.stdout)).toMatchObject({ summary: { failed: 1 } });
    });
});

function io(overrides: Partial<CliIo> = {}): CliIo & { readonly out: string[]; readonly err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
        env: {},
        fetch: () => Promise.reject(new Error('no network')),
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        signal: new AbortController().signal,
        ...overrides,
        out,
        err,
    };
}

describe('runCli', () => {
    it.each([
        [[], '--base-url is required'],
        [['--base-url', 'not a url'], '--base-url is not a URL'],
        [['--base-url', 'ftp://engine.test'], 'must be http or https'],
        [['--base-url', 'https://engine.test', '--report', 'xml'], '--report must be json or junit'],
        [['--base-url', 'https://engine.test', '--suite', 'nope'], 'unknown suite nope'],
        [['--base-url', 'https://engine.test', '--seed', 'abc'], '--seed must be an integer'],
        [['--base-url', 'https://engine.test', '--timeout-ms', '9999999999'], '--timeout-ms must be an integer'],
        [
            ['--base-url', 'https://engine.test', '--mock-control-url', 'http://x', '--target-module', 'x.mjs'],
            'give one of',
        ],
        [['--base-url', 'https://engine.test', '--suite', 'registration'], 'registration starts the engine itself'],
        [['--engine-cmd', 'true', '--target-module', 'x.mjs'], '--target-module is for --base-url'],
        [['--engine-cmd', 'true', '--mock-control-url', 'http://x'], '--mock-control-url is for --base-url'],
        [['--engine-cmd', 'true', '--engine-public-key', 'k'], '--engine-public-key is for --base-url'],
        [['--engine-cmd', 'true', '--suite', 'nope'], 'unknown suite nope'],
        [['--base-url', 'https://engine.test', '--suite', 'tunnel'], 'tunnel starts the engine itself'],
        [['--base-url', 'https://engine.test', '--suite', 'ui-loader'], 'ui-loader starts the engine itself'],
        [['--engine-cmd', 'true', '--base-url', 'https://engine.test'], 'give either --base-url or --engine-cmd'],
        [['--engine-cmd', 'true', '--heartbeat-interval-s', '0'], '--heartbeat-interval-s must be at least 1'],
        [['--base-url', 'https://engine.test', '--mock-control'], '--mock-control needs --engine-cmd'],
        [['--base-url', 'https://engine.test', '--engine-cwd', '.'], '--engine-cwd needs --engine-cmd'],
        [['--base-url', 'https://engine.test', '--engine-session-cmd', 'x'], '--engine-session-cmd needs --engine-cmd'],
        [['--engine-cmd', 'true', '--engine-ca-file', 'ca.pem'], '--engine-ca-file needs --engine-session-cmd'],
        [
            ['--engine-cmd', 'true', '--engine-session-cmd', 'x', '--mock-control'],
            'give either --engine-session-cmd or --mock-control',
        ],
    ])('refuses %j with exit code 2', async (argv, message) => {
        const streams = io();
        expect(await runCli(argv, streams)).toBe(2);
        expect(streams.err.join('')).toContain(message);
    });

    it('prints usage for --help', async () => {
        const streams = io();
        expect(await runCli(['--help'], streams)).toBe(0);
        expect(streams.out.join('')).toBe(`${USAGE}\n`);
    });

    it('refuses a target module without createConformanceTarget', async () => {
        const streams = io();
        const argv = ['--base-url', 'https://engine.test', '--target-module', join(directory, 'empty.mjs')];
        expect(await runCli(argv, streams)).toBe(2);
        expect(streams.err.join('')).toContain('does not export createConformanceTarget');
    });

    it('rethrows what is not a usage error', async () => {
        await expect(runCli(['--unknown-flag'], io())).rejects.toThrow();
    });

    it('runs owner-only from a cookie, skipping what needs members', async () => {
        const engine = await createFakeEngine();
        const owner = await engine.target.session({ kind: 'owner' });
        const streams = io({
            env: { PTBK_CONFORMANCE_OWNER_COOKIE: owner !== null && 'cookie' in owner ? owner.cookie : '' },
            fetch: engine.target.fetch,
        });
        const argv = [
            '--base-url',
            engine.target.baseUrl.href,
            '--filter',
            'engine-api.permissions.read-only-member',
            '--filter',
            'engine-api.engine.',
            '--no-gateway',
            '--seed',
            '3',
            '--timeout-ms',
            '30000',
        ];
        expect(await runCli(argv, streams)).toBe(0);
        const report = JSON.parse(streams.out.join('')) as { seed: number; summary: unknown };
        expect(report.seed).toBe(3);
        expect(report.summary).toEqual({ passed: 1, failed: 0, skipped: 2 });
        expect(streams.err.join('')).toContain(
            'skip  engine-api.permissions.read-only-member: the target provides no member session',
        );
    });

    it('writes JUnit to stdout and fails the run when a check fails', async () => {
        const engine = await createFakeEngine({
            tamper: (request, response) =>
                new URL(request.url).pathname === '/api/v1/engine' ? new Response('{}', { status: 500 }) : response,
        });
        const owner = await engine.target.session({ kind: 'owner' });
        const streams = io({
            env: { PTBK_CONFORMANCE_OWNER_COOKIE: owner !== null && 'cookie' in owner ? owner.cookie : '' },
            fetch: engine.target.fetch,
        });
        const argv = [
            '--base-url',
            engine.target.baseUrl.href,
            '--filter',
            'engine-api.engine.info',
            '--report',
            'junit',
        ];
        expect(await runCli(argv, streams)).toBe(1);
        expect(streams.out.join('')).toContain('<failure message=');
    });

    it('starts the engine itself with --engine-cmd and runs the platform suites', async () => {
        const streams = io({ env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', PTBK_RELAYS: 'wss://ignored' } });
        const argv = [
            '--engine-cmd',
            fakeEngineCommand().command,
            '--engine-cwd',
            directory,
            '--heartbeat-interval-s',
            String(SELF_TEST_HEARTBEAT_INTERVAL_S),
            '--mock-control',
            '--suite',
            'registration,heartbeat',
            '--filter',
            'registration.request.signature-verifies',
            '--report',
            'junit',
        ];
        expect(await runCli(argv, streams)).toBe(0);
        expect(streams.err.join('')).toContain('pass  registration.request.signature-verifies');
        expect(streams.out.join('')).toContain('<testsuite name="registration"');
    });

    it.each([
        ['its control listener', mockEngineCommand().command, ['--mock-control']],
        [
            'its conformance-session command, without the gateway',
            `${MOCK_CONTROL_ENV} ${mockEngineCommand().command}`,
            [
                '--engine-session-cmd',
                `${MOCK_CONTROL_ENV} ${mockEngineCommand().command} conformance-session`,
                '--engine-ca-file',
                '{dataDir}/dev-ca/ca-cert.pem',
                '--no-gateway',
            ],
        ],
    ])(
        'runs every suite, engine-api included, against mock engines it starts, with sessions from %s',
        async (_name, engineCmd, extra) => {
            const streams = io({ env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } });
            const argv = [
                '--engine-cmd',
                engineCmd,
                ...extra,
                '--heartbeat-interval-s',
                String(SELF_TEST_HEARTBEAT_INTERVAL_S),
                '--suite',
                'engine-api,registration,heartbeat,tunnel,ui-loader',
                ...[...ONE_CHECK_PER_SUITE, GATEWAY_CHECK].flatMap((id) => ['--filter', id]),
                '--out',
                join(directory, 'combined.json'),
            ];
            expect(await runCli(argv, streams), streams.err.join('')).toBe(0);
            const report = JSON.parse(await readFile(join(directory, 'combined.json'), 'utf8')) as {
                engineVersion: string | null;
                results: { id: string; outcome: { kind: string } }[];
            };
            expect(report.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
            expect(Object.fromEntries(report.results.map(({ id, outcome }) => [id, outcome.kind]))).toEqual({
                ...Object.fromEntries(ONE_CHECK_PER_SUITE.map((id) => [id, 'pass'])),
                [GATEWAY_CHECK]: extra.includes('--no-gateway') ? 'skip' : 'pass',
            });
        },
        120_000,
    );

    it('signs in through the mock control listener', async () => {
        const engine = await createFakeEngine();
        const fetch: typeof globalThis.fetch = async (input, init) => {
            const request = new Request(input, init);
            if (request.url !== 'http://127.0.0.1:4480/__mock/sessions') return engine.target.fetch(request);
            const subject = ((await request.json()) as { subject: SessionSubject }).subject;
            const credential = await engine.target.session(subject);
            const [name, value] = (credential !== null && 'cookie' in credential ? credential.cookie : '=').split('=');
            return Response.json({ memberId: 'm', cookie: { name, value } }, { status: 201 });
        };
        const streams = io({ fetch });
        const argv = [
            '--base-url',
            engine.target.baseUrl.href,
            '--mock-control-url',
            'http://127.0.0.1:4480',
            '--engine-public-key',
            engine.target.enginePublicKey ?? '',
            '--suite',
            'engine-api',
            '--filter',
            'engine-api.engine.',
            '--out',
            join(directory, 'mock.json'),
        ];
        expect(await runCli(argv, streams)).toBe(0);
        const report = JSON.parse(await readFile(join(directory, 'mock.json'), 'utf8')) as { summary: unknown };
        expect(report.summary).toEqual({ passed: 2, failed: 0, skipped: 0 });
    });
});
