import type { Socket } from 'node:net';
import { connect } from 'node:net';
import { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';

import type { Hostname, RelayMessage, TunnelChallenge } from '@ptbk/protocol';
import {
    FrameType,
    Hostname as HostnameSchema,
    INITIAL_WINDOW_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    StreamId,
    TUNNEL_CLOSE_CODE,
    encodeFrame,
    expectedCnameTarget,
} from '@ptbk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeClock } from '../src/adapters/fake-clock';
import type { TestEngineClient } from '../src/testing/engine-client';
import type { TestEngine } from '../src/testing/engines';
import { ENGINE_DOMAIN, createTestEngine } from '../src/testing/engines';
import { captureClientHello } from '../src/testing/client-hello';
import type { HarnessOptions, RelayHarness } from '../src/testing/relay-harness';
import { RELAY_ID, startHarness } from '../src/testing/relay-harness';

const agents = HostnameSchema.parse('agents.customer.test');
const unclaimed = HostnameSchema.parse('unclaimed.customer.test');
const misdirected = HostnameSchema.parse('misdirected.customer.test');
const IPV4_CLIENT = { family: 4, address: Uint8Array.of(203, 0, 113, 9), port: 50_000 } as const;
const noStream = { data: () => undefined, drain: () => undefined, closed: () => undefined };

function challengeOf(message: RelayMessage): TunnelChallenge {
    if (message.type !== 'challenge') throw new Error(`expected a challenge, got ${message.type}`);
    return message;
}

const relayClientHello = captureClientHello(RELAY_ID);

describe('tunnel endpoint over real sockets', () => {
    let relay: RelayHarness | undefined;
    const sockets: Socket[] = [];

    afterEach(async () => {
        for (const socket of sockets.splice(0)) socket.destroy();
        await relay?.close();
        relay = undefined;
    });

    async function start(options: HarnessOptions = {}): Promise<RelayHarness> {
        relay = await startHarness(options);
        return relay;
    }

    async function register(harness: RelayHarness, seed: number, custom: readonly Hostname[] = []) {
        const engine = await createTestEngine(seed, custom);
        harness.registry.set(engine.engineId, engine.entry);
        return engine;
    }

    async function connected(harness: RelayHarness, engine: TestEngine): Promise<TestEngineClient> {
        const client = harness.connect(engine);
        await client.authenticate(challengeOf(await client.nextMessage()));
        expect(await client.nextMessage()).toMatchObject({ type: 'ready' });
        return client;
    }

    /**
     * A TCP connection that sends a ClientHello for the relay's own hostname and never finishes TLS; resolves once the
     * TLS server answered, so the endpoint has admitted it and armed its deadline.
     */
    async function rawSocket(harness: RelayHarness): Promise<Socket> {
        const socket = connect(harness.port, '127.0.0.1');
        socket.on('error', () => undefined);
        sockets.push(socket);
        const answered = new Promise((resolve) => socket.once('data', resolve));
        socket.write(await relayClientHello);
        await answered;
        return socket;
    }

    async function expectRefused(client: TestEngineClient, reason: string, code: number): Promise<void> {
        expect(await client.nextMessage()).toEqual({ v: 1, type: 'reject', reason });
        expect((await client.closed).code).toBe(code);
    }

    it('authenticates an engine and routes its default and verified custom hostnames only', async () => {
        const harness = await start();
        const engine = await createTestEngine(80, [agents, unclaimed, misdirected]);
        const stranger = await createTestEngine(81, [unclaimed]);
        harness.registry.set(engine.engineId, {
            ...engine.entry,
            claims: engine.entry.claims.map((claim) =>
                claim.hostname === unclaimed ? (stranger.entry.claims[0] ?? claim) : claim,
            ),
        });
        const target = expectedCnameTarget(engine.engineId, ENGINE_DOMAIN);
        harness.dns.setAnswer(agents, { kind: 'cname', target });
        harness.dns.setAnswer(unclaimed, { kind: 'cname', target });
        harness.dns.setAnswer(misdirected, { kind: 'cname', target: stranger.defaultHostname });

        const client = harness.connect(engine);
        const challenge = challengeOf(await client.nextMessage());
        expect(challenge).toMatchObject({ relayId: harness.config.relayId, protocolVersions: [1], features: [] });
        await client.authenticate(challenge);
        expect(await client.nextMessage()).toEqual({
            v: 1,
            type: 'ready',
            protocolVersion: 1,
            features: [],
            hostnames: [engine.defaultHostname, agents],
        });
        const session = harness.listener.sessions.byEngine(engine.engineId);
        expect(session).toBeDefined();
        expect(harness.listener.sessions.byHostname(agents)).toBe(session);
        expect(harness.listener.sessions.byHostname(unclaimed)).toBeUndefined();
        expect(harness.listener.sessions.byHostname(misdirected)).toBeUndefined();
        expect(harness.logger.entries).toContainEqual({
            level: 'info',
            event: 'tunnel.connected',
            fields: { engineId: engine.engineId, engineIp: '127.0.0.1', relayId: harness.config.relayId },
        });
        const logged = JSON.stringify(harness.logger.entries);
        for (const hidden of [challenge.nonce, engine.entry.enginePublicKey, agents, unclaimed, misdirected, '1.8.2']) {
            expect(logged).not.toContain(hidden);
        }
    });

    it('refuses a forged signature (a key claiming another engine) as auth-failed', async () => {
        const harness = await start();
        const victim = await register(harness, 82);
        const attacker = await createTestEngine(83);
        const client = harness.connect(attacker);
        const auth = await client.signAuth(challengeOf(await client.nextMessage()));
        client.sendText(JSON.stringify({ ...auth, engineId: victim.engineId }));
        await expectRefused(client, 'auth-failed', TUNNEL_CLOSE_CODE.AUTH_FAILED);
        expect(harness.logger.entries.find((entry) => entry.event === 'tunnel.rejected')?.fields).toMatchObject({
            engineId: victim.engineId,
            reason: 'bad-signature',
        });
    });

    it('refuses an unknown engine as auth-failed', async () => {
        const harness = await start();
        const client = harness.connect(await createTestEngine(84));
        await client.authenticate(challengeOf(await client.nextMessage()));
        await expectRefused(client, 'auth-failed', TUNNEL_CLOSE_CODE.AUTH_FAILED);
    });

    it('refuses an engine ID that does not derive from the registry key as auth-failed', async () => {
        const harness = await start();
        const engine = await createTestEngine(85);
        const other = await createTestEngine(86);
        harness.registry.set(engine.engineId, other.entry);
        const client = harness.connect(engine);
        await client.authenticate(challengeOf(await client.nextMessage()));
        await expectRefused(client, 'auth-failed', TUNNEL_CLOSE_CODE.AUTH_FAILED);
        expect(JSON.stringify(harness.logger.entries)).toContain('id-key-mismatch');
    });

    it('refuses an auth replayed from an earlier challenge', async () => {
        const harness = await start();
        const engine = await register(harness, 87);
        const first = harness.connect(engine);
        const recorded = await first.signAuth(challengeOf(await first.nextMessage()));
        first.ws.close();
        const second = harness.connect(engine);
        await second.nextMessage();
        second.sendText(JSON.stringify(recorded));
        await expectRefused(second, 'auth-failed', TUNNEL_CLOSE_CODE.AUTH_FAILED);
    });

    it('refuses a downgrade: an auth signed over a stripped relay version list', async () => {
        const harness = await start();
        const engine = await register(harness, 88);
        const client = harness.connect(engine);
        const challenge = challengeOf(await client.nextMessage());
        // What a party in the path would show the engine to force an older version.
        const stripped = { ...challenge, protocolVersions: [1, 2], features: [] };
        client.sendText(JSON.stringify(await client.signAuth(stripped)));
        await expectRefused(client, 'auth-failed', TUNNEL_CLOSE_CODE.AUTH_FAILED);
    });

    it('refuses an engine that shares no protocol version', async () => {
        const harness = await start();
        const engine = await register(harness, 89);
        const client = harness.connect(engine);
        await client.authenticate(challengeOf(await client.nextMessage()), { versions: [7] });
        await expectRefused(client, 'unsupported-version', TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
    });

    it('refuses a suspended engine with suspended', async () => {
        const harness = await start();
        const engine = await createTestEngine(90);
        harness.registry.set(engine.engineId, { ...engine.entry, status: 'suspended' });
        const client = harness.connect(engine);
        await client.authenticate(challengeOf(await client.nextMessage()));
        await expectRefused(client, 'suspended', TUNNEL_CLOSE_CODE.SUSPENDED);
    });

    it('closes an oversize handshake message with PROTOCOL_ERROR and no reject', async () => {
        const harness = await start();
        const engine = await register(harness, 91);
        const client = harness.connect(engine);
        const auth = await client.signAuth(challengeOf(await client.nextMessage()));
        client.sendText(JSON.stringify({ ...auth, padding: 'x'.repeat(5000) }));
        expect((await client.closed).code).toBe(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
    });

    it('refuses an upgrade without the ptbk-tunnel subprotocol', async () => {
        const harness = await start();
        const client = harness.connect(await createTestEngine(92), { protocols: [] });
        await expect(client.opened).rejects.toThrow();
    });

    it('closes a connection that sends no auth within the timeout with timeout and AUTH_FAILED', async () => {
        const harness = await start();
        const client = harness.connect(await register(harness, 93));
        await client.nextMessage();
        harness.clock.advance(harness.config.tunnel.handshakeTimeoutMs);
        await expectRefused(client, 'timeout', TUNNEL_CLOSE_CODE.AUTH_FAILED);
    });

    it('counts the handshake deadline from TCP accept, even when the ClientHello came slowly', async () => {
        const harness = await start();
        const engine = await register(harness, 105);
        const spentMs = 4000;
        const raw = connect(harness.port, '127.0.0.1');
        raw.on('error', () => undefined);
        sockets.push(raw);
        // Sends the first 20 bytes of the ClientHello at once and holds the rest until released.
        const held: Buffer[] = [];
        let holding = true;
        const slow = new Duplex({
            read: () => undefined,
            write(chunk: Buffer, _encoding, callback) {
                if (holding && held.length === 0 && chunk.length > 20) {
                    raw.write(chunk.subarray(0, 20));
                    held.push(chunk.subarray(20));
                } else if (holding) held.push(chunk);
                else raw.write(chunk);
                callback();
            },
        });
        raw.on('data', (chunk: Buffer) => slow.push(chunk));
        raw.on('close', () => slow.destroy());
        const client = harness.connect(engine, {
            createConnection: () => tlsConnect({ socket: slow, servername: RELAY_ID, ca: harness.certificate.cert }),
        });
        await vi.waitFor(() => {
            expect(harness.listener.browser.bufferedBytes()).toBe(20);
        });
        harness.clock.advance(spentMs);
        holding = false;
        for (const chunk of held.splice(0)) raw.write(chunk);
        challengeOf(await client.nextMessage());
        harness.clock.advance(harness.config.tunnel.handshakeTimeoutMs - spentMs - 1);
        expect(harness.logger.entries.some((entry) => entry.event === 'tunnel.rejected')).toBe(false);
        harness.clock.advance(1);
        await expectRefused(client, 'timeout', TUNNEL_CLOSE_CODE.AUTH_FAILED);
    });

    it('drops a TCP connection that never completes TLS once the deadline from accept passes', async () => {
        const harness = await start();
        const socket = await rawSocket(harness);
        const closed = new Promise((resolve) => socket.once('close', resolve));
        harness.clock.advance(harness.config.tunnel.handshakeTimeoutMs - 1);
        expect(socket.destroyed).toBe(false);
        harness.clock.advance(1);
        await closed;
    });

    it('refuses the 11th pending handshake from one IP with rate-limited and 1013', async () => {
        const harness = await start();
        for (let index = 0; index < 10; index++) await rawSocket(harness);
        const client = harness.connect(await register(harness, 94));
        await expectRefused(client, 'rate-limited', 1013);
    });

    it('refuses past the global pending-handshake limit with rate-limited and 1013', async () => {
        const harness = await start({ env: { RELAY_MAX_PENDING_HANDSHAKES: '3' } });
        for (let index = 0; index < 3; index++) await rawSocket(harness);
        const client = harness.connect(await register(harness, 95));
        await expectRefused(client, 'rate-limited', 1013);
    });

    it('closes a tunnel that sends DATA beyond its credit with PROTOCOL_ERROR', async () => {
        const harness = await start();
        const engine = await register(harness, 96);
        const client = await connected(harness, engine);
        const stream = harness.listener.sessions.byEngine(engine.engineId)?.openStream(IPV4_CLIENT, noStream);
        const streamId = StreamId.parse(stream?.id);
        const payload = new Uint8Array(MAX_FRAME_PAYLOAD_BYTES);
        for (let sent = 0; sent <= INITIAL_WINDOW_BYTES; sent += MAX_FRAME_PAYLOAD_BYTES) {
            client.ws.send(encodeFrame({ type: FrameType.DATA, streamId, payload }));
        }
        expect((await client.closed).code).toBe(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
        expect(harness.listener.sessions.byEngine(engine.engineId)).toBeUndefined();
    });

    it('closes a tunnel whose engine sends OPEN with PROTOCOL_ERROR', async () => {
        const harness = await start();
        const engine = await register(harness, 97);
        const client = await connected(harness, engine);
        client.ws.send(encodeFrame({ type: FrameType.OPEN, streamId: StreamId.parse(1), ...IPV4_CLIENT }));
        expect((await client.closed).code).toBe(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
        expect(harness.logger.entries).toContainEqual({
            level: 'info',
            event: 'tunnel.disconnected',
            fields: {
                engineId: engine.engineId,
                engineIp: '127.0.0.1',
                relayId: harness.config.relayId,
                closeCode: TUNNEL_CLOSE_CODE.PROTOCOL_ERROR,
            },
        });
    });

    it.each([
        ['ignorable frames', () => Uint8Array.of(0x85, 0, 0, 0, 1, 9)],
        ['CLOSE for an old stream', () => encodeFrame({ type: FrameType.CLOSE, streamId: StreamId.parse(1), code: 0 })],
    ])('closes a tunnel that floods %s with FRAME_BUDGET at the frame budget', async (_, frame) => {
        const harness = await start({ env: { RELAY_TUNNEL_FRAMES_PER_S: '50' } });
        const engine = await register(harness, 105);
        const client = await connected(harness, engine);
        harness.listener.sessions.byEngine(engine.engineId)?.openStream(IPV4_CLIENT, noStream)?.close(0);
        for (let index = 0; index <= 50; index++) client.ws.send(frame());
        expect((await client.closed).code).toBe(TUNNEL_CLOSE_CODE.FRAME_BUDGET);
        expect(harness.listener.terminations()['frame-budget']).toBe(1);
        expect(JSON.stringify(harness.logger.entries)).not.toContain('frame-budget');
    });

    it.each(['before', 'after'])(
        'terminates a peer that floods pings without reading the pongs, %s auth',
        async (when) => {
            const harness = await start({ env: { RELAY_TUNNEL_PING_BUFFER_BYTES: '16384' } });
            const engine = await register(harness, 106);
            const client = when === 'after' ? await connected(harness, engine) : harness.connect(engine);
            if (when === 'before') await client.nextMessage();
            client.ws.pause();
            const payload = Buffer.alloc(125, 1);
            for (let batch = 0; batch < 400 && harness.listener.terminations()['ping-buffer'] === 0; batch++) {
                for (let index = 0; index < 1000; index++) client.ws.ping(payload);
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            await vi.waitFor(() => {
                expect(harness.listener.terminations()['ping-buffer']).toBe(1);
            });
            expect(harness.listener.sessions.sessions()).toEqual([]);
            expect(harness.logger.entries).toContainEqual({
                level: 'warn',
                event: 'tunnel.terminated',
                fields: { reason: 'ping-buffer' },
            });
        },
    );

    it('replaces an older tunnel of the same engine with REPLACED', async () => {
        const harness = await start();
        const engine = await register(harness, 98);
        const older = await connected(harness, engine);
        await connected(harness, engine);
        expect((await older.closed).code).toBe(TUNNEL_CLOSE_CODE.REPLACED);
    });

    it('disconnects a suspended engine with SUSPENDED after the next revalidation', async () => {
        const harness = await start();
        const engine = await register(harness, 99);
        const client = await connected(harness, engine);
        harness.registry.set(engine.engineId, { ...engine.entry, status: 'suspended' });
        harness.clock.advance(harness.config.registry.ttlMs - 1);
        expect(harness.listener.sessions.byEngine(engine.engineId)).toBeDefined();
        harness.clock.advance(1);
        expect((await client.closed).code).toBe(TUNNEL_CLOSE_CODE.SUSPENDED);
    });

    it('keeps a tunnel through a registry outage shorter than 24 h and closes it with AUTH_FAILED after', async () => {
        const harness = await start({ env: { RELAY_REGISTRY_TTL_S: '3600' } });
        const engine = await register(harness, 100);
        const client = await connected(harness, engine);
        harness.registry.setMode('unavailable');
        const staleRounds = (): number =>
            harness.logger.entries.filter((entry) => entry.event === 'registry.stale').length;
        for (let hour = 1; hour < 24; hour++) {
            harness.clock.advance(3_600_000);
            await vi.waitFor(() => {
                expect(staleRounds()).toBe(hour);
            });
        }
        expect(harness.listener.sessions.byEngine(engine.engineId)).toBeDefined();
        harness.clock.advance(3_600_000);
        expect((await client.closed).code).toBe(TUNNEL_CLOSE_CODE.AUTH_FAILED);
    });

    it('closes a tunnel whose engine stops answering pings', async () => {
        const liveness = createFakeClock();
        const harness = await start({ livenessClock: liveness });
        const engine = await register(harness, 101);
        const silent = harness.connect(engine, { autoPong: false });
        await silent.authenticate(challengeOf(await silent.nextMessage()));
        await silent.nextMessage();
        const pinged = new Promise((resolve) => silent.ws.once('ping', resolve));
        liveness.advance(25_000);
        await pinged;
        liveness.advance(10_000);
        expect((await silent.closed).code).toBe(1006);
    });

    it('keeps a tunnel whose engine answers pings', async () => {
        const liveness = createFakeClock();
        const harness = await start({ livenessClock: liveness });
        const engine = await register(harness, 102);
        const client = await connected(harness, engine);
        const pinged = new Promise((resolve) => client.ws.once('ping', resolve));
        liveness.advance(25_000);
        await pinged;
        // The relay handles frames in order: once it answered our ping, it has seen our pong.
        const ponged = new Promise((resolve) => client.ws.once('pong', resolve));
        client.ws.ping();
        await ponged;
        liveness.advance(10_000);
        expect(harness.listener.sessions.byEngine(engine.engineId)).toBeDefined();
    });

    it('closes every tunnel with SHUTTING_DOWN on close and stops accepting', async () => {
        const harness = await start();
        const engine = await register(harness, 103);
        const client = await connected(harness, engine);
        const waiting = harness.connect(await register(harness, 104));
        await waiting.nextMessage();
        await harness.listener.close();
        expect((await client.closed).code).toBe(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
        expect((await waiting.closed).code).toBe(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
        const late = harness.connect(engine);
        await expect(late.opened).rejects.toThrow();
    });
});
