import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DockerResponse, DockerTransport } from './compose.ts';
import {
    DockerApiError,
    createComposeControl,
    demuxDockerLogs,
    demuxDockerStreams,
    oneOffContainerSpec,
    ownComposeProject,
    unixSocketStreamTransport,
    unixSocketTransport,
} from './compose.ts';

function frame(stream: 1 | 2, text: string): Buffer {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
}

function json(status: number, value: unknown): DockerResponse {
    return { status, body: Buffer.from(JSON.stringify(value)) };
}

/** A daemon with one container per service of project `p`, recording every call. */
function fakeDocker(services: Record<string, string>) {
    const calls: string[] = [];
    const transport: DockerTransport = (method, path) => {
        calls.push(`${method} ${path}`);
        const url = new URL(path, 'http://docker');
        if (url.pathname === '/containers/json') {
            const labels = (JSON.parse(url.searchParams.get('filters') ?? '{}') as { label: string[] }).label;
            const project = labels.find((label) => label.startsWith('com.docker.compose.project='))?.split('=')[1];
            const service = labels.find((label) => label.startsWith('com.docker.compose.service='))?.split('=')[1];
            const id = project === 'p' && service !== undefined ? services[service] : undefined;
            return Promise.resolve(json(200, id === undefined ? [] : [{ Id: id }]));
        }
        if (url.pathname.endsWith('/logs')) {
            return Promise.resolve({ status: 200, body: Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n')]) });
        }
        if (url.pathname.endsWith('/json'))
            return Promise.resolve(json(200, { State: { Health: { Status: 'healthy' } } }));
        return Promise.resolve({ status: url.pathname.endsWith('/start') ? 304 : 204, body: Buffer.alloc(0) });
    };
    return { calls, transport };
}

describe('createComposeControl', () => {
    it("acts only on the project's container for the service", async () => {
        const { calls, transport } = fakeDocker({ 'relay-a': 'abc' });
        const compose = createComposeControl(transport, 'p');
        await compose.stop('relay-a');
        await compose.start('relay-a');
        await compose.kill('relay-a');
        await compose.restart('relay-a');
        await compose.pause('relay-a');
        await compose.unpause('relay-a');
        expect(calls.filter((call) => call.startsWith('POST'))).toEqual([
            'POST /containers/abc/stop?t=10',
            'POST /containers/abc/start',
            'POST /containers/abc/kill?signal=SIGKILL',
            'POST /containers/abc/restart?t=10',
            'POST /containers/abc/pause',
            'POST /containers/abc/unpause',
        ]);
        expect(decodeURIComponent(calls[0] ?? '')).toContain(
            '"label":["com.docker.compose.project=p","com.docker.compose.service=relay-a","com.docker.compose.oneoff=False"]',
        );
    });

    it('reads logs and health', async () => {
        const compose = createComposeControl(fakeDocker({ 'relay-a': 'abc' }).transport, 'p');
        expect(await compose.logs('relay-a')).toBe('out\nerr\n');
        expect(await compose.health('relay-a')).toBe('healthy');
    });

    it('refuses an unknown service and a failing daemon', async () => {
        const compose = createComposeControl(fakeDocker({}).transport, 'p');
        await expect(compose.stop('relay-a')).rejects.toThrow(
            new DockerApiError('find relay-a: expected one container in project p, found 0'),
        );
        const failing = createComposeControl(() => Promise.resolve(json(500, { message: 'boom' })), 'p');
        await expect(failing.logs('relay-a')).rejects.toThrow('find relay-a: Docker API status 500');
    });
});

describe('exec, inspect, streams and networks', () => {
    /** One container `abc` for service `relay-a`, recording calls with their bodies. */
    function daemon() {
        const calls: { method: string; path: string; body: unknown }[] = [];
        const transport: DockerTransport = (method, path, body) => {
            calls.push({ method, path, body });
            const url = new URL(path, 'http://docker');
            if (url.pathname === '/containers/json') return Promise.resolve(json(200, [{ Id: 'abc' }]));
            if (url.pathname === '/containers/abc/exec') return Promise.resolve(json(201, { Id: 'e1' }));
            if (url.pathname === '/exec/e1/start') {
                return Promise.resolve({ status: 200, body: Buffer.concat([frame(1, 'out'), frame(2, 'err')]) });
            }
            if (url.pathname === '/exec/e1/json') return Promise.resolve(json(200, { ExitCode: 3 }));
            if (url.pathname === '/containers/abc/json') {
                return Promise.resolve(
                    json(200, {
                        Id: 'abc',
                        Config: { Env: ['A=1'], Cmd: ['node'], Entrypoint: null, Labels: { l: 'v', n: 1 } },
                        Mounts: [{ Destination: '/pki', Type: 'volume' }, { Type: 'bind' }],
                        NetworkSettings: { Networks: { p_stack: { IPAMConfig: { IPv4Address: '10.0.0.11' } } } },
                    }),
                );
            }
            return Promise.resolve({ status: 200, body: Buffer.alloc(0) });
        };
        return { calls, transport };
    }

    it('runs a command and returns its exit code and both streams', async () => {
        const { calls, transport } = daemon();
        const result = await createComposeControl(transport, 'p').exec('relay-a', ['cat', '/x'], { user: 'nobody' });
        expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
        expect(calls.find((call) => call.path === '/containers/abc/exec')?.body).toEqual({
            AttachStdout: true,
            AttachStderr: true,
            Cmd: ['cat', '/x'],
            User: 'nobody',
        });
    });

    it('reads env, mounts, command and labels, skipping malformed entries', async () => {
        expect(await createComposeControl(daemon().transport, 'p').inspect('relay-a')).toEqual({
            env: ['A=1'],
            cmd: ['node'],
            entrypoint: [],
            mounts: [{ destination: '/pki', type: 'volume' }],
            labels: { l: 'v' },
        });
    });

    it("takes a service off this project's network and puts it back at the same address", async () => {
        const { calls, transport } = daemon();
        const compose = createComposeControl(transport, 'p');
        const address = await compose.disconnectNetwork('relay-a', 'stack');
        await compose.connectNetwork('relay-a', 'stack', address);
        expect(calls.filter((call) => call.method === 'POST').map((call) => [call.path, call.body])).toEqual([
            ['/networks/p_stack/disconnect', { Container: 'abc', Force: true }],
            [
                '/networks/p_stack/connect',
                { Container: 'abc', EndpointConfig: { IPAMConfig: { IPv4Address: '10.0.0.11' } } },
            ],
        ]);
        await expect(compose.disconnectNetwork('relay-a', 'other')).rejects.toThrow('no fixed address on p_other');
    });

    it('streams an export and an archive, and refuses without a stream transport or on an error status', async () => {
        const paths: string[] = [];
        const compose = createComposeControl(daemon().transport, 'p', (path) => {
            paths.push(path);
            const body = (async function* () {
                yield await Promise.resolve(
                    new TextEncoder().encode(path.includes('missing') ? 'no such path' : 'tar'),
                );
            })();
            return Promise.resolve({ status: path.includes('missing') ? 404 : 200, body });
        });
        const chunks: Uint8Array[] = [];
        for await (const chunk of await compose.exportFilesystem('relay-a')) chunks.push(chunk);
        expect(Buffer.concat(chunks).toString()).toBe('tar');
        await compose.archive('relay-a', '/relay-key');
        await expect(compose.archive('relay-a', '/missing')).rejects.toThrow('Docker API status 404');
        expect(paths).toEqual([
            '/containers/abc/export',
            '/containers/abc/archive?path=%2Frelay-key',
            '/containers/abc/archive?path=%2Fmissing',
        ]);
        await expect(createComposeControl(daemon().transport, 'p').exportFilesystem('relay-a')).rejects.toThrow(
            'no streaming transport',
        );
    });
});

describe('run', () => {
    const TEMPLATE = {
        Id: 'tpl',
        Config: {
            Image: 'p-mock-engine',
            Env: ['PTBK_DATA_DIR=/engine', 'PATH=/usr/bin', 'MALFORMED'],
            Cmd: ['node', '/app/main.mjs'],
            Entrypoint: ['docker-entrypoint.sh'],
            User: 'node',
            WorkingDir: '/app',
            Labels: { 'com.docker.compose.project': 'p', 'com.docker.compose.oneoff': 'False' },
        },
        HostConfig: { NetworkMode: 'p_stack', Dns: ['10.0.0.53'] },
        NetworkSettings: { Networks: { p_stack: { IPAMConfig: { IPv4Address: '10.0.0.31' } } } },
    };

    /** The service's container `tpl`; `create` answers with `created` and `start` with `startStatus`. */
    function daemon(startStatus = 204) {
        const calls: { method: string; path: string; body: unknown }[] = [];
        const transport: DockerTransport = (method, path, body) => {
            calls.push({ method, path, body });
            const url = new URL(path, 'http://docker');
            if (url.pathname === '/containers/json') return Promise.resolve(json(200, [{ Id: 'tpl' }]));
            if (url.pathname === '/containers/tpl/json') return Promise.resolve(json(200, TEMPLATE));
            if (url.pathname === '/containers/create') return Promise.resolve(json(201, { Id: 'one' }));
            if (url.pathname === '/containers/one/start') return Promise.resolve(json(startStatus, {}));
            if (url.pathname === '/containers/one/wait') return Promise.resolve(json(200, { StatusCode: 1 }));
            if (url.pathname === '/containers/one/logs') {
                return Promise.resolve({ status: 200, body: frame(1, '{"outcome":"rejected"}\n') });
            }
            if (url.pathname === '/containers/one/exec') return Promise.resolve(json(201, { Id: 'e2' }));
            if (url.pathname === '/exec/e2/start') return Promise.resolve({ status: 200, body: frame(1, 'link\n') });
            if (url.pathname === '/exec/e2/json') return Promise.resolve(json(200, { ExitCode: 0 }));
            return Promise.resolve({ status: 204, body: Buffer.alloc(0) });
        };
        return { calls, transport };
    }

    it("copies the service container's config, with the overrides and labelled as a one-off", () => {
        expect(
            oneOffContainerSpec(TEMPLATE, {
                env: { PTBK_DATA_DIR: '/tmp/engine', PTBK_LINK_CODE: 'abc' },
                command: ['node', '/app/main.mjs', 'register'],
            }),
        ).toEqual({
            Image: 'p-mock-engine',
            Env: ['PATH=/usr/bin', 'MALFORMED', 'PTBK_DATA_DIR=/tmp/engine', 'PTBK_LINK_CODE=abc'],
            Cmd: ['node', '/app/main.mjs', 'register'],
            Entrypoint: ['docker-entrypoint.sh'],
            User: 'node',
            WorkingDir: '/app',
            Labels: { 'com.docker.compose.project': 'p', 'com.docker.compose.oneoff': 'True' },
            HostConfig: { NetworkMode: 'p_stack', Dns: ['10.0.0.53'] },
            NetworkingConfig: { EndpointsConfig: { p_stack: {} } },
        });
    });

    it('keeps the fixed address only when asked to, and the command unless replaced', () => {
        const spec = oneOffContainerSpec(TEMPLATE, { fixedAddress: true });
        expect(spec['NetworkingConfig']).toEqual({
            EndpointsConfig: { p_stack: { IPAMConfig: { IPv4Address: '10.0.0.31' } } },
        });
        expect(spec['Cmd']).toEqual(['node', '/app/main.mjs']);
        expect(spec['Env']).toEqual(TEMPLATE.Config.Env);
    });

    it('refuses a template without an image or host config', () => {
        expect(() => oneOffContainerSpec({ Config: {} })).toThrow('no image or host config');
        expect(() => oneOffContainerSpec(null)).toThrow('no image or host config');
    });

    it('creates and starts the container, then waits, reads, stops and removes it', async () => {
        const { calls, transport } = daemon();
        const container = await createComposeControl(transport, 'p').run('mock-engine', { env: { A: '1' } });
        expect(container.id).toBe('one');
        expect(container.name).toMatch(/^p-mock-engine-run-[0-9a-f]{12}$/);
        expect(await container.wait()).toBe(1);
        expect(await container.logs('stdout')).toBe('{"outcome":"rejected"}\n');
        await container.logs();
        await container.stop();
        await container.remove();
        expect(calls.slice(2).map((call) => `${call.method} ${call.path}`)).toEqual([
            `POST /containers/create?name=${container.name}`,
            'POST /containers/one/start',
            'POST /containers/one/wait',
            'GET /containers/one/logs?stdout=true&stderr=false',
            'GET /containers/one/logs?stdout=true&stderr=true',
            'POST /containers/one/stop?t=10',
            'DELETE /containers/one?force=true&v=true',
        ]);
        expect((calls[2]?.body as { Env: string[] }).Env).toContain('A=1');
    });

    it('runs a command in the one-off container, not in the service container', async () => {
        const { calls, transport } = daemon();
        const container = await createComposeControl(transport, 'p').run('mock-engine');
        expect(await container.exec(['node', '/app/main.mjs', 'setup-link', '--json'])).toEqual({
            exitCode: 0,
            stdout: 'link\n',
            stderr: '',
        });
        expect(calls.find((call) => call.path === '/containers/one/exec')?.body).toEqual({
            AttachStdout: true,
            AttachStderr: true,
            Cmd: ['node', '/app/main.mjs', 'setup-link', '--json'],
        });
        expect(calls.some((call) => call.path === '/containers/tpl/exec')).toBe(false);
    });

    it('removes a container that failed to start', async () => {
        const { calls, transport } = daemon(500);
        await expect(createComposeControl(transport, 'p').run('mock-engine')).rejects.toThrow('Docker API status 500');
        expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/containers/one?force=true&v=true' });
    });
});

describe('demuxDockerStreams', () => {
    it('keeps stdout and stderr apart and refuses a truncated stream', () => {
        expect(demuxDockerStreams(Buffer.concat([frame(1, 'a'), frame(2, 'b'), frame(1, 'c')]))).toEqual({
            stdout: 'ac',
            stderr: 'b',
        });
        expect(() => demuxDockerStreams(frame(1, 'abc').subarray(0, 10))).toThrow('truncated');
    });
});

describe('ownComposeProject', () => {
    it('reads the project label of the container we run in', async () => {
        const transport: DockerTransport = (_method, path) =>
            Promise.resolve(
                path === '/containers/host1/json'
                    ? json(200, { Config: { Labels: { 'com.docker.compose.project': 'ptbk-e2e-x' } } })
                    : json(404, {}),
            );
        expect(await ownComposeProject(transport, 'host1')).toBe('ptbk-e2e-x');
        await expect(ownComposeProject(transport, 'other')).rejects.toThrow('status 404');
        await expect(ownComposeProject(() => Promise.resolve(json(200, { Config: {} })), 'h')).rejects.toThrow(
            'not a compose container',
        );
    });
});

describe('demuxDockerLogs', () => {
    it('joins multiplexed frames and passes TTY output through', () => {
        expect(demuxDockerLogs(Buffer.concat([frame(1, 'a'), frame(2, 'b'), frame(1, 'c')]))).toBe('abc');
        expect(demuxDockerLogs(Buffer.from('plain tty output\n'))).toBe('plain tty output\n');
        expect(demuxDockerLogs(Buffer.alloc(0))).toBe('');
    });

    it('refuses a truncated or corrupted stream', () => {
        expect(() => demuxDockerLogs(frame(1, 'abc').subarray(0, 10))).toThrow('truncated');
        expect(() => demuxDockerLogs(Buffer.concat([frame(1, 'a'), Buffer.from('garbage!!')]))).toThrow('malformed');
    });
});

describe('unixSocketTransport', () => {
    it('sends a JSON body and streams a response', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'docker-'));
        const socketPath = join(directory, 's');
        const server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                res.end(JSON.stringify({ type: req.headers['content-type'], body: Buffer.concat(chunks).toString() }));
            });
        });
        await new Promise<void>((resolve) => server.listen(socketPath, resolve));
        try {
            const response = await unixSocketTransport(socketPath)('POST', '/exec/e1/start', { Detach: false });
            expect(JSON.parse(response.body.toString())).toEqual({
                type: 'application/json',
                body: '{"Detach":false}',
            });
            const streamed = await unixSocketStreamTransport(socketPath)('/containers/abc/export');
            const chunks: Uint8Array[] = [];
            for await (const chunk of streamed.body) chunks.push(chunk);
            expect(streamed.status).toBe(200);
            expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ body: '' });
        } finally {
            await new Promise((resolve) => server.close(resolve));
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('speaks HTTP over the socket under a pinned API version', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'docker-'));
        const socketPath = join(directory, 's');
        const server = createServer((req, res) => {
            res.end(JSON.stringify({ method: req.method, url: req.url }));
        });
        await new Promise<void>((resolve) => server.listen(socketPath, resolve));
        try {
            const response = await unixSocketTransport(socketPath)('POST', '/containers/abc/stop?t=10');
            expect(response.status).toBe(200);
            expect(JSON.parse(response.body.toString())).toEqual({
                method: 'POST',
                url: '/v1.43/containers/abc/stop?t=10',
            });
        } finally {
            await new Promise((resolve) => server.close(resolve));
            await rm(directory, { recursive: true, force: true });
        }
    });
});
