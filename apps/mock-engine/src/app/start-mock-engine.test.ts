import type { TunnelAuth } from '@ptbk/protocol';
import {
    CLOSE_CODE,
    EngineVersion,
    FrameType,
    Hostname,
    RelayId,
    StreamId,
    TUNNEL_FEATURES,
    TUNNEL_PROTOCOL_VERSIONS,
    TunnelAuth as TunnelAuthSchema,
    decodeFrame,
    encodeBase64Url,
    encodeFrame,
} from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createMemoryIdentityStore } from '../adapters/memory-identity-store';
import type { TunnelDuplex } from '../adapters/tunnel-duplex';
import type { ManagedCertificateSource } from '../domain/tls/certificate-source';
import type { RelayLinkState } from '../domain/tunnel/relay-link';
import type { RelayTarget } from '../domain/tunnel/relay-target';
import { createFakeClock } from '../testing/fake-clock';
import type { FakeConnection } from '../testing/fake-dialer';
import { createFakeDialer, flush, until } from '../testing/fake-dialer';
import { createMemoryLogger } from '../testing/memory-logger';
import { createSeededRandom } from '../testing/seeded-random';
import type { MockEngineConfig } from './config';
import { DEFAULT_TUNNEL_OFFER, startMockEngine } from './start-mock-engine';
import { DEFAULT_MOCK_SETTINGS } from '../testing/mock-settings';

function relay(name: string): RelayTarget {
    return { url: `wss://${name}/v1/tunnel`, relayId: RelayId.parse(name), port: 443 };
}

const CONFIG: MockEngineConfig = {
    mode: 'tunnel',
    dataDir: '/unused',
    relays: [relay('relay-a.ptbk.test'), relay('relay-b.ptbk.test')],
    engineDomain: Hostname.parse('engines.ptbk.test'),
    engineVersion: EngineVersion.parse('0.1.0'),
    proxy: null,
    extraCaFile: null,
    devCaFiles: null,
    devCaDomains: [],
    logLevel: 'info',
    ...DEFAULT_MOCK_SETTINGS,
};

async function start(certificates?: ManagedCertificateSource) {
    const dialer = createFakeDialer();
    const logger = createMemoryLogger();
    const clock = createFakeClock();
    const states: [string, RelayLinkState['kind']][] = [];
    const engine = await startMockEngine(CONFIG, {
        logger,
        clock,
        random: createSeededRandom(1),
        identityStore: createMemoryIdentityStore(),
        dialer,
        onLinkState: (target, state) => states.push([target.relayId, state.kind]),
        ...(certificates === undefined ? {} : { certificates }),
    });
    return { dialer, logger, clock, states, engine };
}
type Started = Awaited<ReturnType<typeof start>>;

async function handshake(
    started: Started,
    index: number,
    extraHostnames: readonly string[] = [],
): Promise<FakeConnection> {
    const dial = started.dialer.dials[index];
    if (dial === undefined) throw new Error('no dial');
    const connection = dial.open();
    await flush();
    connection.relayJson({
        v: 1,
        type: 'challenge',
        nonce: encodeBase64Url(new Uint8Array(32).fill(index + 1)),
        relayId: dial.target.relayId,
        protocolVersions: [1],
        features: [],
    });
    await until(() => connection.texts.length === 1);
    const auth: TunnelAuth = TunnelAuthSchema.parse(JSON.parse(connection.texts[0] ?? ''));
    connection.relayJson({
        v: 1,
        type: 'ready',
        protocolVersion: 1,
        features: [],
        hostnames: [started.engine.hostname, ...extraHostnames],
    });
    expect(auth.engineId).toBe(started.engine.identity.engineId);
    return connection;
}

const openFrame = encodeFrame({
    type: FrameType.OPEN,
    streamId: StreamId.parse(1),
    family: 6,
    address: Uint8Array.of(0x20, 0x01, 0x0d, 0xb8, ...new Array<number>(11).fill(0), 1),
    port: 443,
});

describe('startMockEngine', () => {
    it('advertises exactly what the protocol package implements', () => {
        expect(DEFAULT_TUNNEL_OFFER).toEqual({
            protocolVersions: [...TUNNEL_PROTOCOL_VERSIONS],
            features: [...TUNNEL_FEATURES],
        });
    });

    it('dials every relay at once and keeps them independent', async () => {
        const started = await start();
        expect(started.dialer.dials.map((dial) => dial.target.relayId)).toEqual([
            'relay-a.ptbk.test',
            'relay-b.ptbk.test',
        ]);
        started.dialer.dials[0]?.fail({ reason: 'network' });
        await handshake(started, 1);
        expect(started.engine.links.map((link) => link.state().kind)).toEqual(['backoff', 'ready']);
        expect(started.states).toContainEqual(['relay-b.ptbk.test', 'ready']);
        expect(started.engine.hostname).toBe(`${started.engine.identity.engineId}.engines.ptbk.test`);
        expect(started.logger.entries[0]).toEqual({
            level: 'info',
            event: 'engine.started',
            fields: {
                engineId: started.engine.identity.engineId,
                hostname: started.engine.hostname,
                version: '0.1.0',
                relays: 2,
                proxy: false,
                scenario: 'small-team',
                seed: 1,
            },
        });
    });

    it('refuses streams while no handler is set', async () => {
        const started = await start();
        const connection = await handshake(started, 0);
        connection.relayBinary(openFrame);
        expect(connection.binaries.map((bytes) => decodeFrame(bytes))).toEqual([
            { kind: 'frame', frame: { type: FrameType.CLOSE, streamId: 1, code: CLOSE_CODE.REFUSED } },
        ]);
        expect(started.logger.entries).toContainEqual({
            level: 'warn',
            event: 'stream.refused',
            fields: { relay: 'wss://relay-a.ptbk.test/v1/tunnel', stream: 1 },
        });
    });

    it('hands each stream to the handler as a duplex with the client address, until it is removed', async () => {
        const started = await start();
        const connection = await handshake(started, 0);
        const received: [TunnelDuplex, string][] = [];
        const remove = started.engine.onStream((duplex, target) => {
            received.push([duplex, target.relayId]);
        });
        const other = started.engine.onStream(() => undefined);
        remove();
        other();
        started.engine.onStream((duplex, target) => {
            received.push([duplex, target.relayId]);
        });
        connection.relayBinary(openFrame);
        expect(received).toHaveLength(1);
        const [duplex, relayId] = received[0] ?? [];
        expect(relayId).toBe('relay-a.ptbk.test');
        expect(duplex?.remoteAddress).toBe('2001:db8::1');
        expect(duplex?.remotePort).toBe(443);
        connection.relayBinary(
            encodeFrame({ type: FrameType.DATA, streamId: StreamId.parse(1), payload: Uint8Array.of(104, 105) }),
        );
        expect(duplex?.read()).toEqual(Buffer.from('hi'));
    });

    it('closes every tunnel on close', async () => {
        const started = await start();
        const first = await handshake(started, 0);
        const second = await handshake(started, 1);
        const closing = started.engine.close();
        expect(first.closeCodes).toEqual([1001]);
        expect(second.closeCodes).toEqual([1001]);
        first.relayClose(1001);
        second.relayClose(1001);
        await closing;
        expect(started.engine.links.map((link) => link.state().kind)).toEqual(['stopped', 'stopped']);
        expect(started.logger.entries.at(-1)?.event).toBe('engine.stopped');
    });

    describe('with certificates', () => {
        function recordingSource() {
            const added: string[][] = [];
            let closed = 0;
            const source: ManagedCertificateSource = {
                current: () => undefined,
                onChange: () => () => undefined,
                addHostnames(hostnames) {
                    added.push([...hostnames]);
                },
                close() {
                    closed++;
                },
            };
            return { source, added, closed: () => closed };
        }

        it('asks for the default hostname at start and for every hostname a relay confirms', async () => {
            const recording = recordingSource();
            const started = await start(recording.source);
            expect(recording.added).toEqual([[started.engine.hostname]]);
            await handshake(started, 0, ['agents.customer.test']);
            expect(recording.added.at(-1)).toEqual([started.engine.hostname, 'agents.customer.test']);
            expect(started.states).toContainEqual(['relay-a.ptbk.test', 'ready']);
        });

        it('serves streams with the TLS server, restored after an override is removed', async () => {
            const recording = recordingSource();
            const started = await start(recording.source);
            const connection = await handshake(started, 0);
            const remove = started.engine.onStream(() => undefined);
            remove();
            connection.relayBinary(openFrame);
            // Not a ClientHello: the TLS server fails the handshake and closes the stream.
            connection.relayBinary(
                encodeFrame({
                    type: FrameType.DATA,
                    streamId: StreamId.parse(1),
                    payload: new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n'),
                }),
            );
            await until(() => started.logger.entries.some((entry) => entry.event === 'tls.handshake-failed'));
            await until(() =>
                connection.binaries.some((bytes) => {
                    const decoded = decodeFrame(bytes);
                    return decoded.kind === 'frame' && decoded.frame.type === FrameType.CLOSE;
                }),
            );
            expect(started.logger.entries.some((entry) => entry.event === 'stream.refused')).toBe(false);
        });

        it('stops the certificate source on close', async () => {
            const recording = recordingSource();
            const started = await start(recording.source);
            started.dialer.dials[0]?.fail({ reason: 'network' });
            started.dialer.dials[1]?.fail({ reason: 'network' });
            await started.engine.close();
            expect(recording.closed()).toBe(1);
        });
    });
});
