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
    ownComposeProject,
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
