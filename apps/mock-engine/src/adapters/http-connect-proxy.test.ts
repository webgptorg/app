import { once } from 'node:events';
import type { AddressInfo, Socket } from 'node:net';
import * as net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { secret } from '../domain/secret';
import { MAX_PROXY_RESPONSE_HEAD_BYTES, openConnectTunnel, proxyFor } from './http-connect-proxy';
import type { NoProxyRule, ProxyConfig } from './proxy-config';

function proxyConfig(port: number, overrides: Partial<ProxyConfig> = {}): ProxyConfig {
    return { host: '127.0.0.1', port, credentials: null, noProxy: [], ...overrides };
}

interface RawProxy {
    readonly port: number;
    /** The request head each connection sent, once complete. */
    readonly heads: Promise<string>[];
}

const servers: net.Server[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.close();
        await once(server, 'close');
    }
});

/** A TCP server that answers the request head with `respond`, to exercise every parser branch. */
async function rawProxy(respond: (socket: Socket) => void): Promise<RawProxy> {
    const heads: Promise<string>[] = [];
    const server = net.createServer((socket) => {
        socket.on('error', () => undefined);
        heads.push(
            new Promise((resolve) => {
                let text = '';
                socket.on('data', (chunk: Buffer) => {
                    text += chunk.toString('latin1');
                    if (text.includes('\r\n\r\n')) {
                        resolve(text);
                        respond(socket);
                    }
                });
            }),
        );
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { port: (server.address() as AddressInfo).port, heads };
}

function signal(): AbortSignal {
    return new AbortController().signal;
}

describe('proxyFor', () => {
    const rule = (host: string, port: number | null = null): NoProxyRule => ({ host, port });
    const cases: readonly [string, readonly NoProxyRule[], string, number, boolean][] = [
        ['no rules', [], 'relay-a.example', 443, true],
        ['star', [rule('*')], 'relay-a.example', 443, false],
        ['exact host', [rule('relay-a.example')], 'relay-a.example', 443, false],
        ['suffix on a label boundary', [rule('example')], 'relay-a.example', 443, false],
        ['suffix without a label boundary', [rule('a.example')], 'relay-aa.example', 443, true],
        ['parent of the rule', [rule('relay-a.example')], 'example', 443, true],
        ['case-insensitive', [rule('example')], 'RELAY-A.EXAMPLE', 443, false],
        ['matching port', [rule('example', 443)], 'relay-a.example', 443, false],
        ['other port', [rule('example', 8443)], 'relay-a.example', 443, true],
        ['any of several', [rule('other.test'), rule('example')], 'relay-a.example', 443, false],
    ];
    it.each(cases)('%s', (_name, noProxy, host, port, proxied) => {
        const proxy = proxyConfig(3128, { noProxy });
        expect(proxyFor(proxy, host, port)).toBe(proxied ? proxy : null);
    });

    it('is null without a proxy', () => {
        expect(proxyFor(null, 'relay-a.example', 443)).toBeNull();
    });
});

describe('openConnectTunnel', () => {
    it('sends CONNECT with Host and hands over the socket after a 2xx, keeping early bytes', async () => {
        const proxy = await rawProxy((socket) => {
            socket.write('HTTP/1.1 200 Connection Established\r\nVia: test\r\n\r\nearly');
        });
        const result = await openConnectTunnel({
            proxy: proxyConfig(proxy.port),
            host: 'relay-a.example',
            port: 443,
            signal: signal(),
        });
        expect(result.kind).toBe('connected');
        if (result.kind !== 'connected') return;
        const head = await proxy.heads[0];
        expect(head).toBe('CONNECT relay-a.example:443 HTTP/1.1\r\nHost: relay-a.example:443\r\n\r\n');
        result.socket.resume();
        const [chunk] = (await once(result.socket, 'data')) as [Buffer];
        expect(chunk.toString()).toBe('early');
        result.socket.destroy();
    });

    it('accepts an HTTP/1.0 status line without a reason phrase', async () => {
        const proxy = await rawProxy((socket) => {
            socket.write('HTTP/1.0 200\r\n\r\n');
        });
        const result = await openConnectTunnel({
            proxy: proxyConfig(proxy.port),
            host: 'h.test',
            port: 1,
            signal: signal(),
        });
        expect(result.kind).toBe('connected');
        if (result.kind === 'connected') result.socket.destroy();
    });

    it('brackets an IPv6 target', async () => {
        const proxy = await rawProxy((socket) => {
            socket.write('HTTP/1.1 200 OK\r\n\r\n');
        });
        const result = await openConnectTunnel({
            proxy: proxyConfig(proxy.port),
            host: '::1',
            port: 443,
            signal: signal(),
        });
        expect(await proxy.heads[0]).toMatch(/^CONNECT \[::1\]:443 HTTP\/1\.1\r\nHost: \[::1\]:443\r\n/);
        if (result.kind === 'connected') result.socket.destroy();
    });

    it('sends Basic credentials from the configuration', async () => {
        const proxy = await rawProxy((socket) => {
            socket.write('HTTP/1.1 200 OK\r\n\r\n');
        });
        const credentials = { username: 'alice', password: secret('s3cr:et') };
        const result = await openConnectTunnel({
            proxy: proxyConfig(proxy.port, { credentials }),
            host: 'relay-a.example',
            port: 443,
            signal: signal(),
        });
        const expected = Buffer.from('alice:s3cr:et').toString('base64');
        expect(await proxy.heads[0]).toContain(`\r\nProxy-Authorization: Basic ${expected}\r\n`);
        if (result.kind === 'connected') result.socket.destroy();
    });

    it('fails a 407 with the status only, never the credentials', async () => {
        const proxy = await rawProxy((socket) => {
            socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n');
        });
        const credentials = { username: 'alice', password: secret('hunter2') };
        const result = await openConnectTunnel({
            proxy: proxyConfig(proxy.port, { credentials }),
            host: 'relay-a.example',
            port: 443,
            signal: signal(),
        });
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'proxy-status', status: 407 } });
        expect(JSON.stringify(result)).not.toMatch(/alice|hunter2/);
    });

    it.each([
        ['a malformed status line', (socket: Socket) => socket.write('SSH-2.0-OpenSSH\r\n\r\n')],
        [
            'a head that never ends within the bound',
            (socket: Socket) => socket.write('x'.repeat(MAX_PROXY_RESPONSE_HEAD_BYTES + 1)),
        ],
        [
            'a complete head over the bound',
            (socket: Socket) =>
                socket.write(`HTTP/1.1 200 OK\r\nX: ${'x'.repeat(MAX_PROXY_RESPONSE_HEAD_BYTES)}\r\n\r\n`),
        ],
        ['a close before the head ends', (socket: Socket) => socket.end('HTTP/1.1 200 OK\r\n')],
        ['a reset', (socket: Socket) => socket.resetAndDestroy()],
    ])('fails %s as network', async (_name, respond) => {
        const proxy = await rawProxy(respond);
        const result = await openConnectTunnel({
            proxy: proxyConfig(proxy.port),
            host: 'h.test',
            port: 1,
            signal: signal(),
        });
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'network' } });
    });

    it('fails a refused connection as network', async () => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const { port } = server.address() as AddressInfo;
        server.close();
        await once(server, 'close');
        const result = await openConnectTunnel({ proxy: proxyConfig(port), host: 'h.test', port: 1, signal: signal() });
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'network' } });
    });

    it('fails as aborted when the signal is already aborted', async () => {
        const result = await openConnectTunnel({
            proxy: proxyConfig(1),
            host: 'h.test',
            port: 1,
            signal: AbortSignal.abort(),
        });
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'aborted' } });
    });

    it('fails as aborted when aborted while waiting for the answer', async () => {
        const controller = new AbortController();
        const proxy = await rawProxy(() => {
            controller.abort();
        });
        const result = await openConnectTunnel({
            proxy: proxyConfig(proxy.port),
            host: 'h.test',
            port: 1,
            signal: controller.signal,
        });
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'aborted' } });
    });
});
