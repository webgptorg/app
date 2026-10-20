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
import type { RelayLinkState } from '../domain/tunnel/relay-link';
import type { RelayTarget } from '../domain/tunnel/relay-target';
import { createFakeClock } from '../testing/fake-clock';
import type { FakeConnection } from '../testing/fake-dialer';
import { createFakeDialer, flush, until } from '../testing/fake-dialer';
import { createMemoryLogger } from '../testing/memory-logger';
import { createSeededRandom } from '../testing/seeded-random';
import type { MockEngineConfig } from './config';
import { DEFAULT_TUNNEL_OFFER, startMockEngine } from './start-mock-engine';

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
    logLevel: 'info',
};

async function start() {
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
    });
    return { dialer, logger, clock, states, engine };
}
type Started = Awaited<ReturnType<typeof start>>;

async function handshake(started: Started, index: number): Promise<FakeConnection> {
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
        hostnames: [started.engine.hostname],
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
});
