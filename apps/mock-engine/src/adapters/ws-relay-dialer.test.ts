import { once } from 'node:events';
import * as https from 'node:https';
import type { AddressInfo, LookupFunction } from 'node:net';
import * as net from 'node:net';

import type { Bytes, Hostname, RelayId, TunnelChallenge } from '@ptbk/protocol';
import {
    EngineVersion,
    Hostname as HostnameSchema,
    RelayId as RelayIdSchema,
    TUNNEL_CLOSE_CODE,
    TUNNEL_PATH,
    createWebCryptoSigner,
    generateEd25519KeyPair,
    parseRelayMessage,
    signTunnelAuth,
} from '@ptbk/protocol';
import { WebSocketServer } from 'ws';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { RelayConnection, RelayConnectionHandlers } from '../domain/tunnel/relay-dialer';
import type { RelayTarget } from '../domain/tunnel/relay-target';
import { engineIdentityFromSigner, signerOf } from '../domain/identity/engine-identity';
import type { EngineIdentity } from '../domain/identity/engine-identity';
import { secret } from '../domain/secret';
import type { ConnectProxy, ConnectProxyOptions } from '../testing/connect-proxy';
import { startConnectProxy } from '../testing/connect-proxy';
import { createFakeClock } from '../testing/fake-clock';
import type { FakeClock } from '../testing/fake-clock';
import type { FakeRelay, FakeRelayOptions } from '../testing/fake-relay';
import { startFakeRelay } from '../testing/fake-relay';
import type { TestCa, TestCertificate } from '../testing/test-pki';
import { createTestCa } from '../testing/test-pki';
import type { ProxyConfig } from './proxy-config';
import type { WsRelayDialerOptions } from './ws-relay-dialer';
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_PONG_TIMEOUT_MS, createWsRelayDialer } from './ws-relay-dialer';

const RELAY_ID: RelayId = RelayIdSchema.parse('relay-a.test');
const PING_INTERVAL_MS = 25_000;

const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
};

let ca: TestCa;
let relayCert: TestCertificate;
let identity: EngineIdentity;
let hostname: Hostname;

beforeAll(async () => {
    ca = createTestCa('Relay test CA');
    relayCert = ca.issue([RELAY_ID]);
    identity = await engineIdentityFromSigner(
        await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false })),
    );
    hostname = HostnameSchema.parse(`${identity.engineId}.engine.test`);
});

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function relay(overrides: Partial<FakeRelayOptions> = {}): Promise<FakeRelay> {
    const started = await startFakeRelay({
        relayId: RELAY_ID,
        tls: relayCert,
        registry: (engineId) =>
            engineId === identity.engineId ? { publicKey: identity.publicKey, hostnames: [hostname] } : undefined,
        ...overrides,
    });
    cleanups.push(() => started.close());
    return started;
}

async function proxy(options: Partial<ConnectProxyOptions> = {}): Promise<ConnectProxy> {
    const started = await startConnectProxy({ resolve: () => '127.0.0.1', ...options });
    cleanups.push(() => started.close());
    return started;
}

function proxyConfig(started: ConnectProxy, overrides: Partial<ProxyConfig> = {}): ProxyConfig {
    return { host: started.host, port: started.port, credentials: null, noProxy: [], ...overrides };
}

function target(port: number): RelayTarget {
    return { url: `wss://${RELAY_ID}:${String(port)}${TUNNEL_PATH}`, relayId: RELAY_ID, port };
}

interface Recorder extends RelayConnectionHandlers {
    readonly texts: string[];
    readonly binaries: Bytes[];
    readonly closes: number[];
    nextText(): Promise<string>;
    nextBinary(): Promise<Bytes>;
    closed(): Promise<number>;
}

function recorder(): Recorder {
    const texts: string[] = [];
    const binaries: Bytes[] = [];
    const closes: number[] = [];
    const waiting = { text: [] as ((text: string) => void)[], binary: [] as ((bytes: Bytes) => void)[] };
    const closeWaiters: ((code: number) => void)[] = [];
    let readText = 0;
    let readBinary = 0;
    return {
        texts,
        binaries,
        closes,
        onText(text) {
            texts.push(text);
            waiting.text.shift()?.(text);
        },
        onBinary(bytes) {
            binaries.push(bytes);
            waiting.binary.shift()?.(bytes);
        },
        onClose(code) {
            closes.push(code);
            for (const waiter of closeWaiters.splice(0)) waiter(code);
        },
        nextText() {
            const text = texts[readText++];
            if (text !== undefined) return Promise.resolve(text);
            return new Promise((resolve) => waiting.text.push(resolve));
        },
        nextBinary() {
            const bytes = binaries[readBinary++];
            if (bytes !== undefined) return Promise.resolve(bytes);
            return new Promise((resolve) => waiting.binary.push(resolve));
        },
        closed() {
            const code = closes[0];
            if (code !== undefined) return Promise.resolve(code);
            return new Promise((resolve) => closeWaiters.push(resolve));
        },
    };
}

function dialer(clock: FakeClock, options: Partial<WsRelayDialerOptions> = {}) {
    return createWsRelayDialer({ clock, proxy: null, ca: [ca.certPem], lookup, ...options });
}

async function dialOpen(
    clock: FakeClock,
    port: number,
    options: Partial<WsRelayDialerOptions> = {},
): Promise<{ connection: RelayConnection; events: Recorder }> {
    const events = recorder();
    const result = await dialer(clock, options).dial(target(port), events, new AbortController().signal);
    if (result.kind !== 'open') throw new Error(`dial failed: ${JSON.stringify(result.failure)}`);
    return { connection: result.connection, events };
}

/** Answers the relay's challenge the way the relay link does, and returns the relay's next message. */
async function handshake(connection: RelayConnection, events: Recorder): Promise<string> {
    const challenge = parseRelayMessage(await events.nextText());
    if (challenge.kind !== 'ok' || challenge.message.type !== 'challenge') throw new Error('expected a challenge');
    const signed = await signTunnelAuth(
        signerOf(identity),
        challenge.message satisfies TunnelChallenge,
        { version: EngineVersion.parse('0.1.0'), protocolVersions: [1], features: [] },
        { dialledRelayId: RELAY_ID },
    );
    if (signed.kind !== 'signed') throw new Error('wrong relay');
    connection.sendText(JSON.stringify(signed.auth));
    return events.nextText();
}

/** A TLS server with the relay certificate whose upgrade handling the test controls. */
async function customRelay(
    configure: (server: https.Server) => void,
    certificate: TestCertificate = relayCert,
): Promise<number> {
    const server = https.createServer({ cert: certificate.certPem, key: certificate.keyPem });
    const sockets = new Set<net.Socket>();
    server.on('connection', (socket: net.Socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    server.on('tlsClientError', () => undefined);
    configure(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(async () => {
        for (const socket of sockets) socket.destroy();
        server.close();
        await once(server, 'close');
    });
    return (server.address() as AddressInfo).port;
}

/** A TCP server that accepts and then does nothing, or what `onConnection` says. */
async function silentServer(onConnection: (socket: net.Socket) => void = () => undefined): Promise<{
    port: number;
    connected: Promise<net.Socket>;
}> {
    let resolveConnected: (socket: net.Socket) => void = () => undefined;
    const connected = new Promise<net.Socket>((resolve) => {
        resolveConnected = resolve;
    });
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        onConnection(socket);
        resolveConnected(socket);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(async () => {
        for (const socket of sockets) socket.destroy();
        server.close();
        await once(server, 'close');
    });
    return { port: (server.address() as AddressInfo).port, connected };
}

describe('direct connection', () => {
    it('opens a verified WebSocket and carries the handshake and binary frames', async () => {
        const fake = await relay();
        const clock = createFakeClock();
        const { connection, events } = await dialOpen(clock, fake.port);
        const ready = parseRelayMessage(await handshake(connection, events));
        expect(ready).toMatchObject({
            kind: 'ok',
            message: { type: 'ready', protocolVersion: 1, hostnames: [hostname] },
        });

        const session = await fake.waitForSession();
        const received: Bytes[] = [];
        const echoed = new Promise<void>((resolve) => {
            session.onBinary((bytes) => {
                received.push(bytes);
                resolve();
            });
        });
        connection.sendBinary(Uint8Array.of(1, 2, 3));
        await echoed;
        expect(received).toEqual([Uint8Array.of(1, 2, 3)]);

        session.sendBinary(Uint8Array.of(9, 8));
        expect(await events.nextBinary()).toEqual(Uint8Array.of(9, 8));
        session.sendText('{"late":true}');
        expect(await events.nextText()).toBe('{"late":true}');
    });

    it('closes once, idempotently, and cancels its timers', async () => {
        const fake = await relay();
        const clock = createFakeClock();
        const { connection, events } = await dialOpen(clock, fake.port);
        await handshake(connection, events);
        const session = await fake.waitForSession();
        expect(clock.pendingTimers()).toBe(1);

        connection.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
        connection.close(1000);
        expect(await events.closed()).toBe(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
        expect(await session.closed).toBe(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
        connection.close(1000);
        connection.sendText('ignored');
        connection.sendBinary(Uint8Array.of(1));
        expect(events.closes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(clock.pendingTimers()).toBe(0);
    });

    it('reports a close from the relay', async () => {
        const fake = await relay();
        const { connection, events } = await dialOpen(createFakeClock(), fake.port);
        await handshake(connection, events);
        (await fake.waitForSession()).close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
        expect(await events.closed()).toBe(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
    });

    it('fails a refused connection as network', async () => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const { port } = server.address() as AddressInfo;
        server.close();
        await once(server, 'close');
        const result = await dialer(createFakeClock()).dial(target(port), recorder(), new AbortController().signal);
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'network' } });
    });

    it('fails an unresolvable relay hostname as network', async () => {
        const result = await dialer(createFakeClock(), { lookup: undefined }).dial(
            target(443),
            recorder(),
            new AbortController().signal,
        );
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'network' } });
    });

    it('fails a reset during the TLS handshake as network', async () => {
        const { port } = await silentServer((socket) => {
            socket.once('data', () => socket.resetAndDestroy());
        });
        const result = await dialer(createFakeClock()).dial(target(port), recorder(), new AbortController().signal);
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'network' } });
    });
});

describe('certificate verification', () => {
    const viaProxy = [false, true] as const;

    it.each(viaProxy)('rejects a certificate for another hostname (via proxy: %s)', async (useProxy) => {
        const fake = await relay({ tls: ca.issue(['other.test']) });
        const options = useProxy ? { proxy: proxyConfig(await proxy()) } : {};
        const result = await dialer(createFakeClock(), options).dial(
            target(fake.port),
            recorder(),
            new AbortController().signal,
        );
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'tls' } });
        expect(fake.connections()).toBe(0);
    });

    it.each(viaProxy)('rejects a certificate from an untrusted CA (via proxy: %s)', async (useProxy) => {
        const fake = await relay({ tls: createTestCa('Untrusted CA').issue([RELAY_ID]) });
        const options = useProxy ? { proxy: proxyConfig(await proxy()) } : {};
        const result = await dialer(createFakeClock(), options).dial(
            target(fake.port),
            recorder(),
            new AbortController().signal,
        );
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'tls' } });
        expect(fake.connections()).toBe(0);
    });

    it("keeps Node's default roots when no CA is configured", async () => {
        const fake = await relay();
        const result = await dialer(createFakeClock(), { ca: undefined }).dial(
            target(fake.port),
            recorder(),
            new AbortController().signal,
        );
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'tls' } });
    });
});

describe('through an HTTP CONNECT proxy', () => {
    it('tunnels to the relay by name and completes the handshake', async () => {
        const fake = await relay();
        const connectProxy = await proxy();
        const { connection, events } = await dialOpen(createFakeClock(), fake.port, {
            proxy: proxyConfig(connectProxy),
            lookup: undefined,
        });
        expect(parseRelayMessage(await handshake(connection, events))).toMatchObject({ message: { type: 'ready' } });
        expect(connectProxy.requests).toEqual([
            { target: `${RELAY_ID}:${String(fake.port)}`, hadAuth: false, status: 200 },
        ]);
        connection.close(1000);
        await events.closed();
    });

    it('sends the configured credentials', async () => {
        const fake = await relay();
        const connectProxy = await proxy({ requireAuth: { username: 'alice', password: 'hunter2' } });
        const credentials = { username: 'alice', password: secret('hunter2') };
        const { connection, events } = await dialOpen(createFakeClock(), fake.port, {
            proxy: proxyConfig(connectProxy, { credentials }),
        });
        expect(connectProxy.requests).toEqual([expect.objectContaining({ hadAuth: true, status: 200 })]);
        connection.close(1000);
        await events.closed();
    });

    it('fails a 407 with the status only', async () => {
        const fake = await relay();
        const connectProxy = await proxy({ requireAuth: { username: 'alice', password: 'hunter2' } });
        const credentials = { username: 'alice', password: secret('wrong-password') };
        const result = await dialer(createFakeClock(), { proxy: proxyConfig(connectProxy, { credentials }) }).dial(
            target(fake.port),
            recorder(),
            new AbortController().signal,
        );
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'proxy-status', status: 407 } });
        expect(JSON.stringify(result)).not.toMatch(/alice|wrong-password/);
    });

    it('bypasses the proxy for a NO_PROXY host', async () => {
        const fake = await relay();
        const connectProxy = await proxy();
        const { connection, events } = await dialOpen(createFakeClock(), fake.port, {
            proxy: proxyConfig(connectProxy, { noProxy: [{ host: 'test', port: null }] }),
        });
        expect(connectProxy.requests).toEqual([]);
        connection.close(1000);
        await events.closed();
    });
});

describe('WebSocket upgrade', () => {
    it('fails an HTTP answer to the upgrade as upgrade-status', async () => {
        const port = await customRelay((server) => {
            server.on('upgrade', (_request, socket: net.Socket) => {
                socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            });
        });
        const result = await dialer(createFakeClock()).dial(target(port), recorder(), new AbortController().signal);
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'upgrade-status', status: 404 } });
    });

    it('fails a relay that does not agree to the subprotocol as protocol', async () => {
        const port = await customRelay((server) => {
            const wss = new WebSocketServer({ server, handleProtocols: () => false });
            wss.on('connection', () => undefined);
        });
        const result = await dialer(createFakeClock()).dial(target(port), recorder(), new AbortController().signal);
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'protocol' } });
    });

    it('fails a relay that drops the connection during the upgrade as network', async () => {
        const port = await customRelay((server) => {
            server.on('upgrade', (_request, socket: net.Socket) => {
                socket.destroy();
            });
        });
        const result = await dialer(createFakeClock()).dial(target(port), recorder(), new AbortController().signal);
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'network' } });
    });
});

describe('timeouts and aborts', () => {
    it('fails as timeout when the server accepts TCP and never answers', async () => {
        const server = await silentServer();
        const clock = createFakeClock();
        const pending = dialer(clock).dial(target(server.port), recorder(), new AbortController().signal);
        await server.connected;
        clock.advance(DEFAULT_CONNECT_TIMEOUT_MS - 1);
        clock.advance(1);
        expect(await pending).toEqual({ kind: 'failed', failure: { reason: 'timeout' } });
        expect(clock.pendingTimers()).toBe(0);
    });

    it('applies the timeout to the proxy step too', async () => {
        const server = await silentServer();
        const clock = createFakeClock();
        const pending = dialer(clock, {
            proxy: { host: '127.0.0.1', port: server.port, credentials: null, noProxy: [] },
            connectTimeoutMs: 500,
        }).dial(target(443), recorder(), new AbortController().signal);
        await server.connected;
        clock.advance(500);
        expect(await pending).toEqual({ kind: 'failed', failure: { reason: 'timeout' } });
    });

    it('applies the timeout to the upgrade', async () => {
        let upgraded: () => void = () => undefined;
        const upgradeSeen = new Promise<void>((resolve) => {
            upgraded = resolve;
        });
        const port = await customRelay((server) => {
            server.on('upgrade', () => {
                upgraded();
            });
        });
        const clock = createFakeClock();
        const pending = dialer(clock).dial(target(port), recorder(), new AbortController().signal);
        await upgradeSeen;
        clock.advance(DEFAULT_CONNECT_TIMEOUT_MS);
        expect(await pending).toEqual({ kind: 'failed', failure: { reason: 'timeout' } });
    });

    it('fails as aborted on an already aborted signal', async () => {
        const result = await dialer(createFakeClock()).dial(target(1), recorder(), AbortSignal.abort());
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'aborted' } });
    });

    it('fails as aborted when aborted mid-dial', async () => {
        const server = await silentServer();
        const controller = new AbortController();
        const clock = createFakeClock();
        const pending = dialer(clock).dial(target(server.port), recorder(), controller.signal);
        await server.connected;
        controller.abort();
        clock.advance(DEFAULT_CONNECT_TIMEOUT_MS);
        expect(await pending).toEqual({ kind: 'failed', failure: { reason: 'aborted' } });
        expect(clock.pendingTimers()).toBe(0);
    });

    it('fails as aborted when aborted during the upgrade', async () => {
        const controller = new AbortController();
        const port = await customRelay((server) => {
            server.on('upgrade', () => {
                controller.abort();
            });
        });
        const result = await dialer(createFakeClock()).dial(target(port), recorder(), controller.signal);
        expect(result).toEqual({ kind: 'failed', failure: { reason: 'aborted' } });
    });
});

describe('liveness', () => {
    /** One frame there and back: anything the relay received before it, such as a ping, has been answered. */
    async function roundTrip(fake: FakeRelay, connection: RelayConnection, events: Recorder): Promise<void> {
        const session = await fake.waitForSession();
        session.onBinary((bytes) => {
            session.sendBinary(bytes);
        });
        connection.sendBinary(Uint8Array.of(7));
        await events.nextBinary();
    }

    it('pings every interval and stays open while pongs arrive', async () => {
        const fake = await relay();
        const clock = createFakeClock();
        const { connection, events } = await dialOpen(clock, fake.port);
        await handshake(connection, events);
        clock.advance(PING_INTERVAL_MS);
        await roundTrip(fake, connection, events);
        clock.advance(DEFAULT_PONG_TIMEOUT_MS);
        clock.advance(PING_INTERVAL_MS);
        expect(events.closes).toEqual([]);
        connection.close(1000);
        await events.closed();
    });

    it('keeps one ping outstanding when the pong deadline outlasts the interval', async () => {
        const fake = await relay({ autoPong: false });
        const clock = createFakeClock();
        const { connection, events } = await dialOpen(clock, fake.port, { pingIntervalMs: 100, pongTimeoutMs: 250 });
        await handshake(connection, events);
        clock.advance(100);
        await roundTrip(fake, connection, events);
        clock.advance(200);
        expect(events.closes).toEqual([]);
        clock.advance(50);
        expect(await events.closed()).toBe(1006);
    });

    it('terminates the connection when no pong arrives in time', async () => {
        const fake = await relay({ autoPong: false });
        const clock = createFakeClock();
        const { connection, events } = await dialOpen(clock, fake.port, { pingIntervalMs: 1000, pongTimeoutMs: 400 });
        await handshake(connection, events);
        clock.advance(1000);
        await roundTrip(fake, connection, events);
        clock.advance(399);
        expect(events.closes).toEqual([]);
        clock.advance(1);
        expect(await events.closed()).toBe(1006);
        expect(clock.pendingTimers()).toBe(0);
    });
});
