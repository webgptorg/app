import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConnectProxy } from '../testing/connect-proxy';
import { startConnectProxy } from '../testing/connect-proxy';
import { createTestCa } from '../testing/test-pki';
import { lookupLoopback } from '../testing/test-hosts';
import { createHttpsFetch } from './https-fetch';
import type { ProxyConfig } from './proxy-config';
import { secret } from '../domain/secret';

const HOST = 'dashboard.ptbk.test';
const PROXY_PASSWORD = 'dashboard-proxy-password';
const ca = createTestCa('M-06 test CA');

interface Received {
    readonly method: string;
    readonly url: string;
    readonly host: string | undefined;
    readonly body: string;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(
    hostnames: readonly string[] = [HOST],
    handler: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => {
        response.writeHead(201, { 'content-type': 'application/json', 'x-answer': 'yes' });
        response.end('{"ok":true}');
    },
): Promise<{ readonly port: number; readonly received: Received[] }> {
    const leaf = ca.issue(hostnames);
    const received: Received[] = [];
    const server: Server = createServer({ cert: leaf.certPem, key: leaf.keyPem }, (request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            received.push({
                method: request.method ?? '',
                url: request.url ?? '',
                host: request.headers.host,
                body: Buffer.concat(chunks).toString('utf8'),
            });
            handler(request, response);
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(async () => {
        server.closeAllConnections();
        server.close();
        await once(server, 'close');
    });
    return { port: (server.address() as AddressInfo).port, received };
}

async function proxy(requireAuth = false): Promise<ConnectProxy> {
    const started = await startConnectProxy({
        resolve: () => '127.0.0.1',
        ...(requireAuth ? { requireAuth: { username: 'engine', password: PROXY_PASSWORD } } : {}),
    });
    cleanups.push(() => started.close());
    return started;
}

function proxyConfig(started: ConnectProxy, noProxy: ProxyConfig['noProxy'] = []): ProxyConfig {
    return {
        host: started.host,
        port: started.port,
        credentials: { username: 'engine', password: secret(PROXY_PASSWORD) },
        noProxy,
    };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected a rejection');
}

describe('createHttpsFetch', () => {
    it('posts a body over verified TLS and reads status, headers and body', async () => {
        const server = await startServer();
        const fetchHttps = createHttpsFetch({ proxy: null, ca: [ca.certPem], lookup: lookupLoopback });
        const response = await fetchHttps(`https://${HOST}:${String(server.port)}/v1/engines/register?x=1`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"hello":"dashboard"}',
        });
        expect(response.status).toBe(201);
        expect(response.headers.get('x-answer')).toBe('yes');
        expect(await response.json()).toEqual({ ok: true });
        expect(server.received).toEqual([
            {
                method: 'POST',
                url: '/v1/engines/register?x=1',
                host: `${HOST}:${String(server.port)}`,
                body: '{"hello":"dashboard"}',
            },
        ]);
    });

    it('sends a GET without a body', async () => {
        const server = await startServer();
        const fetchHttps = createHttpsFetch({ proxy: null, ca: [ca.certPem], lookup: lookupLoopback });
        const response = await fetchHttps(`https://${HOST}:${String(server.port)}/`);
        expect(response.status).toBe(201);
        expect(server.received[0]?.body).toBe('');
    });

    it('answers a 204 with a null body', async () => {
        const server = await startServer([HOST], (_request, response) => {
            response.writeHead(204).end();
        });
        const fetchHttps = createHttpsFetch({ proxy: null, ca: [ca.certPem], lookup: lookupLoopback });
        const response = await fetchHttps(`https://${HOST}:${String(server.port)}/`, { method: 'POST', body: 'x' });
        expect(response.status).toBe(204);
        expect(response.body).toBeNull();
    });

    it('goes through the CONNECT proxy with credentials, and checks the certificate by name', async () => {
        const server = await startServer();
        const started = await proxy(true);
        const fetchHttps = createHttpsFetch({ proxy: proxyConfig(started), ca: [ca.certPem] });
        const response = await fetchHttps(`https://${HOST}:${String(server.port)}/v1/x`, {
            method: 'POST',
            body: 'through',
        });
        expect(response.status).toBe(201);
        expect(started.requests).toEqual([{ target: `${HOST}:${String(server.port)}`, hadAuth: true, status: 200 }]);
        expect(server.received[0]?.body).toBe('through');
    });

    it('bypasses the proxy for a NO_PROXY host', async () => {
        const server = await startServer();
        const started = await proxy();
        const fetchHttps = createHttpsFetch({
            proxy: proxyConfig(started, [{ host: 'ptbk.test', port: null }]),
            ca: [ca.certPem],
            lookup: lookupLoopback,
        });
        const response = await fetchHttps(`https://${HOST}:${String(server.port)}/`);
        expect(response.status).toBe(201);
        expect(started.requests).toEqual([]);
    });

    it('fails without the proxy status, URL or credentials when the proxy refuses', async () => {
        const server = await startServer();
        const started = await proxy(true);
        const fetchHttps = createHttpsFetch({
            proxy: { ...proxyConfig(started), credentials: null },
            ca: [ca.certPem],
        });
        const error = await rejection(fetchHttps(`https://${HOST}:${String(server.port)}/`));
        expect(error).toBeInstanceOf(TypeError);
        expect(String(error)).not.toContain(HOST);
        expect(String(error)).not.toContain(PROXY_PASSWORD);
        expect(started.requests[0]?.status).toBe(407);
    });

    it('refuses a certificate from an untrusted CA', async () => {
        const server = await startServer();
        const fetchHttps = createHttpsFetch({
            proxy: null,
            ca: [createTestCa('Other CA').certPem],
            lookup: lookupLoopback,
        });
        const error = await rejection(fetchHttps(`https://${HOST}:${String(server.port)}/`));
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).not.toContain(HOST);
        expect(server.received).toEqual([]);
    });

    it('refuses a certificate for another hostname, also through the proxy', async () => {
        const server = await startServer(['other.ptbk.test']);
        const direct = createHttpsFetch({ proxy: null, ca: [ca.certPem], lookup: lookupLoopback });
        expect(await rejection(direct(`https://${HOST}:${String(server.port)}/`))).toBeInstanceOf(TypeError);
        const started = await proxy(true);
        const proxied = createHttpsFetch({ proxy: proxyConfig(started), ca: [ca.certPem] });
        const error = await rejection(proxied(`https://${HOST}:${String(server.port)}/`));
        expect(error).toBeInstanceOf(TypeError);
        expect(String(error)).not.toContain(PROXY_PASSWORD);
        expect(server.received).toEqual([]);
    });

    it('refuses plain http URLs', async () => {
        const fetchHttps = createHttpsFetch({ proxy: null });
        await expect(fetchHttps('http://dashboard.ptbk.test/')).rejects.toThrow(TypeError);
    });

    it('rejects with the abort reason when the signal is aborted', async () => {
        const server = await startServer([HOST], () => {
            // Never answers: only the abort ends the request.
        });
        const fetchHttps = createHttpsFetch({ proxy: null, ca: [ca.certPem], lookup: lookupLoopback });
        const already = new AbortController();
        already.abort(new Error('stopped before'));
        await expect(fetchHttps(`https://${HOST}:${String(server.port)}/`, { signal: already.signal })).rejects.toThrow(
            'stopped before',
        );
        const later = new AbortController();
        const pending = fetchHttps(`https://${HOST}:${String(server.port)}/`, {
            method: 'POST',
            body: 'x',
            signal: later.signal,
        });
        while (server.received.length === 0) await new Promise((resolve) => setImmediate(resolve));
        later.abort(new Error('stopped during'));
        await expect(pending).rejects.toThrow('stopped during');
    });
});
