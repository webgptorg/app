import { request } from 'node:https';

import type { Bytes, TunnelChallenge } from '@ptbk/protocol';
import {
    EngineVersion,
    FrameType,
    Hostname,
    StreamId,
    TUNNEL_CLOSE_CODE,
    createWebCryptoSigner,
    encodeFrame,
    generateEd25519KeyPair,
    signTunnelAuth,
} from '@ptbk/protocol';
import type { Signer } from '@ptbk/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FakeRelay } from '../fake-relay/fake-relay';
import { startFakeRelay } from '../fake-relay/fake-relay';
import { createTestCa } from '../pki/test-ca';
import type { TestCa } from '../pki/test-ca';
import { closeCode, dialRelay, nextJson } from '../testing/relay-client';
import { TunnelRuntime } from './runtime';
import type { TunnelTiming } from './runtime';
import { relayIdsFor } from './tunnel-relay';

const ENGINE_DOMAIN = Hostname.parse('engine.localhost');
const TIMING: TunnelTiming = {
    authMs: 300,
    reconnectMs: 500,
    relayRestartMs: 500,
    shuttingDownMs: 500,
    closeMs: 300,
    observeMs: 100,
    replacedObserveMs: 200,
    quietMs: 50,
    pingMs: 200,
    minBackoffSpreadMs: 10,
    requestMs: 500,
};

let ca: TestCa;
let relay: FakeRelay;
let runtime: TunnelRuntime;
let signer: Signer;
const [RELAY] = relayIdsFor(1);

function engineOf(key: Bytes) {
    return {
        enginePublicKey: key,
        restart: () => Promise.resolve(),
        running: () => true,
        logs: () => '',
        certificateAuthority: () => Promise.resolve(null),
    };
}

beforeEach(async () => {
    ca = createTestCa('handshake test CA', { permittedDomains: ['localhost'] });
    relay = await startFakeRelay({ relayIds: relayIdsFor(1), trustedCa: ca });
    runtime = new TunnelRuntime(relay, ENGINE_DOMAIN, TIMING);
    signer = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
});

afterEach(async () => {
    await relay.close();
});

async function answer(challenge: TunnelChallenge, versions: number[] = [1], by: Signer = signer) {
    const signed = await signTunnelAuth(
        by,
        challenge,
        { version: EngineVersion.parse('1.0.0'), protocolVersions: versions, features: [] },
        { dialledRelayId: challenge.relayId },
    );
    if (signed.kind !== 'signed') throw new Error('not signed');
    return signed.auth;
}

describe('the honest relay handshake', () => {
    if (RELAY === undefined) throw new Error('no relay');

    it('holds early connections until the engine is attached, then reaches ready', async () => {
        const ws = await dialRelay(relay, RELAY, ca.certPem);
        const challengeArrives = nextJson(ws);
        runtime.attach(engineOf(signer.publicKey()));
        const challenge = (await challengeArrives) as unknown as TunnelChallenge;
        const ready = nextJson(ws);
        ws.send(JSON.stringify(await answer(challenge)));
        expect(await ready).toMatchObject({ type: 'ready', protocolVersion: 1 });
        expect(await runtime.waitReady(RELAY, 500, AbortSignal.timeout(1_000))).not.toBeNull();
        ws.terminate();
    });

    it.each([
        ['an auth signed by another key', 'other-key', TUNNEL_CLOSE_CODE.AUTH_FAILED],
        ['no common protocol version', 'version-2', TUNNEL_CLOSE_CODE.PROTOCOL_ERROR],
        ['a binary message instead of auth', 'binary', TUNNEL_CLOSE_CODE.PROTOCOL_ERROR],
        ['text that is not auth', 'garbage', TUNNEL_CLOSE_CODE.PROTOCOL_ERROR],
        ['no answer at all', 'silence', TUNNEL_CLOSE_CODE.AUTH_FAILED],
    ])('refuses %s', async (_name, mode, code) => {
        runtime.attach(engineOf(signer.publicKey()));
        const ws = await dialRelay(relay, RELAY, ca.certPem);
        const challenge = (await nextJson(ws)) as unknown as TunnelChallenge;
        const closed = closeCode(ws);
        if (mode === 'other-key') {
            const other = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
            ws.send(JSON.stringify(await answer(challenge, [1], other)));
        } else if (mode === 'version-2') {
            ws.send(JSON.stringify(await answer(challenge, [2])));
        } else if (mode === 'binary') {
            ws.send(encodeFrame({ type: FrameType.WINDOW, streamId: StreamId.parse(1), increment: 1 }));
        } else if (mode === 'garbage') {
            ws.send('{"v":1}');
        }
        expect(await closed).toBe(code);
        expect(runtime.openTunnels(RELAY)).toEqual([]);
    });

    it('refuses an auth whose engine ID is not the registered key', async () => {
        const other = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
        runtime.attach(engineOf(other.publicKey()));
        const ws = await dialRelay(relay, RELAY, ca.certPem);
        const challenge = (await nextJson(ws)) as unknown as TunnelChallenge;
        const closed = closeCode(ws);
        ws.send(JSON.stringify(await answer(challenge)));
        expect(await closed).toBe(TUNNEL_CLOSE_CODE.AUTH_FAILED);
    });

    it('lets an engine that closes during the handshake go', async () => {
        runtime.attach(engineOf(signer.publicKey()));
        const ws = await dialRelay(relay, RELAY, ca.certPem);
        await nextJson(ws);
        ws.close(1000);
        expect(await runtime.waitReady(RELAY, 100, AbortSignal.timeout(1_000))).toBeNull();
    });
});

describe('the fake relay', () => {
    if (RELAY === undefined) throw new Error('no relay');

    it('counts requests outside the tunnel path and refuses them', async () => {
        await expect(dialRelay(relay, RELAY, ca.certPem, { path: '/elsewhere' })).rejects.toThrow();
        const status = await new Promise<number>((resolve, reject) => {
            const outgoing = request(
                { host: '127.0.0.1', port: relay.port, servername: RELAY, ca: ca.certPem, path: '/v1/tunnel' },
                (incoming) => {
                    incoming.resume();
                    resolve(incoming.statusCode ?? 0);
                },
            );
            outgoing.on('error', reject);
            outgoing.end();
        });
        expect(status).toBe(404);
        expect(relay.counters(RELAY)).toMatchObject({ strayRequests: 2, upgrades: 0 });
        expect(() => relay.counters(RelayIdOther())).toThrow(RangeError);
    });

    it('drops connections while it is down and serves no unknown relay name', async () => {
        relay.setAccepting(false);
        await expect(dialRelay(relay, RELAY, ca.certPem)).rejects.toThrow();
        relay.setAccepting(true);
        const unknown = relayIdsFor(2)[1];
        if (unknown === undefined) throw new Error('no second relay');
        await expect(dialRelay(relay, unknown, ca.certPem)).rejects.toThrow();
    });

    it('answers a connection nobody handles with 1011', async () => {
        const bare = await startFakeRelay({ relayIds: [RELAY], trustedCa: ca });
        try {
            const ws = await dialRelay(bare, RELAY, ca.certPem);
            expect(await closeCode(ws)).toBe(1011);
        } finally {
            await bare.close();
        }
    });
});

function RelayIdOther() {
    const id = relayIdsFor(3)[2];
    if (id === undefined) throw new Error('no third relay');
    return id;
}
