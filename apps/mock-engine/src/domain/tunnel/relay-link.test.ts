import type { Bytes, TunnelAuth, TunnelFeature, TunnelRejectReason } from '@ptbk/protocol';
import {
    CLOSE_CODE,
    EngineVersion,
    FrameType,
    Hostname,
    RelayId,
    StreamId,
    TUNNEL_CLOSE_CODE,
    TunnelAuth as TunnelAuthSchema,
    TunnelChallenge,
    TunnelFeature as TunnelFeatureSchema,
    createWebCryptoSigner,
    defaultHostname,
    encodeBase64Url,
    encodeFrame,
    generateEd25519KeyPair,
    negotiateTunnel,
    verifyTunnelAuth,
} from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import type { FakeConnection } from '../../testing/fake-dialer';
import { createFakeDialer, flush, until } from '../../testing/fake-dialer';
import { createMemoryLogger } from '../../testing/memory-logger';
import { createSeededRandom } from '../../testing/seeded-random';
import type { EngineIdentity } from '../identity/engine-identity';
import { engineIdentityFromSigner } from '../identity/engine-identity';
import {
    BACKOFF_CAP_MS,
    HEALTHY_RESET_MS,
    SHUTTING_DOWN_JITTER_MS,
    WS_CLOSE_TRY_AGAIN_LATER,
    nextDelayMs,
} from './backoff';
import type { RelayLinkState, TunnelOfferConfig } from './relay-link';
import { HANDSHAKE_TIMEOUT_MS, STOP_TIMEOUT_MS, createRelayLink } from './relay-link';
import type { RelayTarget } from './relay-target';
import type { StreamEvents, TunnelStream } from './tunnel-stream';

const RELAY_ID = RelayId.parse('relay-a.ptbk.test');
const TARGET: RelayTarget = { url: 'wss://relay-a.ptbk.test/v1/tunnel', relayId: RELAY_ID, port: 443 };
const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const ENGINE_VERSION = EngineVersion.parse('1.8.2');
const SEED = 42;

const features = (...names: string[]): TunnelFeature[] => names.map((name) => TunnelFeatureSchema.parse(name));
const V1_OFFER: TunnelOfferConfig = { protocolVersions: [1], features: [] };
const WIDE_OFFER: TunnelOfferConfig = { protocolVersions: [3, 1, 2], features: features('beta', 'alpha') };

let identityPromise: Promise<EngineIdentity> | undefined;
function testIdentity(): Promise<EngineIdentity> {
    identityPromise ??= generateEd25519KeyPair({ extractable: false })
        .then((keyPair) => createWebCryptoSigner(keyPair))
        .then((signer) => engineIdentityFromSigner(signer));
    return identityPromise;
}

const noEvents: StreamEvents = { data: () => undefined, sendCredit: () => undefined, closed: () => undefined };

async function setup(offer: TunnelOfferConfig = V1_OFFER) {
    const identity = await testIdentity();
    const clock = createFakeClock(1_000_000);
    const dialer = createFakeDialer();
    const logger = createMemoryLogger();
    const streams: TunnelStream[] = [];
    const states: RelayLinkState[] = [];
    const ownHostname = defaultHostname(identity.engineId, ENGINE_DOMAIN);
    const link = createRelayLink({
        relay: TARGET,
        identity,
        engineVersion: ENGINE_VERSION,
        offer,
        defaultHostname: ownHostname,
        dialer,
        clock,
        random: createSeededRandom(SEED),
        logger,
        onStream: (stream) => {
            streams.push(stream);
            return noEvents;
        },
        onStateChange: (state) => states.push(state),
    });
    /** The link's backoff draws from its own seeded Random; this twin predicts every delay. */
    const twin = createSeededRandom(SEED);
    return { identity, clock, dialer, logger, streams, states, link, ownHostname, twin };
}
type Context = Awaited<ReturnType<typeof setup>>;

const nonceRandom = createSeededRandom(7);
function challenge(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        type: 'challenge',
        nonce: encodeBase64Url(nonceRandom.bytes(32)),
        relayId: RELAY_ID,
        protocolVersions: [1],
        features: [],
        ...overrides,
    };
}

async function open(ctx: Context): Promise<FakeConnection> {
    if (ctx.link.state().kind === 'idle') ctx.link.start();
    const connection = ctx.dialer.last().open();
    await flush();
    return connection;
}

/** Plays the relay up to `auth` and returns what the engine signed. */
async function toAuth(ctx: Context, relayChallenge: Record<string, unknown> = challenge()) {
    const connection = await open(ctx);
    connection.relayJson(relayChallenge);
    await until(() => connection.texts.length === 1);
    const auth = TunnelAuthSchema.parse(JSON.parse(connection.texts[0] ?? ''));
    return { connection, auth, challenge: TunnelChallenge.parse(relayChallenge) };
}

function honestReady(relayChallenge: TunnelChallenge, auth: TunnelAuth, hostnames: string[]) {
    const negotiation = negotiateTunnel(
        { versions: relayChallenge.protocolVersions, features: relayChallenge.features },
        { versions: auth.protocolVersions, features: auth.features },
    );
    if (negotiation.kind !== 'ok') throw new Error('no common version');
    return {
        v: 1,
        type: 'ready',
        protocolVersion: negotiation.protocolVersion,
        features: negotiation.features,
        hostnames,
    };
}

async function toReady(ctx: Context, relayChallenge: Record<string, unknown> = challenge()) {
    const exchange = await toAuth(ctx, relayChallenge);
    exchange.connection.relayJson(honestReady(exchange.challenge, exchange.auth, [ctx.ownHostname]));
    expect(ctx.link.state().kind).toBe('ready');
    return exchange;
}

function events(ctx: Context): string[] {
    return ctx.logger.entries.map((entry) => entry.event);
}

function expectBackoff(ctx: Context, attempt: number): number {
    const state = ctx.link.state();
    if (state.kind !== 'backoff') throw new Error(`expected backoff, got ${state.kind}`);
    expect(state.attempt).toBe(attempt);
    expect(state.delayMs).toBe(nextDelayMs(attempt - 1, ctx.twin));
    return state.delayMs;
}

describe('handshake', () => {
    it('advertises its versions and features, signs the negotiation and records the version the relay picked', async () => {
        const ctx = await setup(WIDE_OFFER);
        const relayChallenge = challenge({ protocolVersions: [2, 1, 9], features: features('beta', 'gamma') });
        const { connection, auth, challenge: parsed } = await toAuth(ctx, relayChallenge);

        expect(ctx.dialer.last().target).toBe(TARGET);
        expect(auth).toMatchObject({
            engineId: ctx.identity.engineId,
            version: ENGINE_VERSION,
            protocolVersions: [3, 1, 2],
            features: ['beta', 'alpha'],
        });
        expect(ctx.link.state()).toEqual({ kind: 'handshaking', attempt: 1 });

        connection.relayJson(honestReady(parsed, auth, [ctx.ownHostname]));
        expect(ctx.link.state()).toEqual({
            kind: 'ready',
            session: { protocolVersion: 2, features: ['beta'], hostnames: [ctx.ownHostname] },
        });
        expect(ctx.states.map((state) => state.kind)).toEqual(['connecting', 'handshaking', 'ready']);
        expect(events(ctx)).not.toContain('tunnel.default-hostname-missing');
        expect(connection.closeCodes).toEqual([]);
    });

    it('sends an auth that verifies, and fails verification when any signed part is changed', async () => {
        const ctx = await setup(WIDE_OFFER);
        const relayChallenge = TunnelChallenge.parse(
            challenge({ protocolVersions: [1, 2], features: features('alpha', 'gamma') }),
        );
        const { auth } = await toAuth(ctx, relayChallenge);
        const key = ctx.identity.publicKey;
        expect(verifyTunnelAuth(key, relayChallenge, auth)).toBe(true);

        const tamperedChallenges = [
            { ...relayChallenge, protocolVersions: [1] },
            { ...relayChallenge, protocolVersions: [1, 3] },
            { ...relayChallenge, features: features('alpha') },
            { ...relayChallenge, features: features('alpha', 'delta') },
            { ...relayChallenge, features: [] },
        ];
        for (const tampered of tamperedChallenges) expect(verifyTunnelAuth(key, tampered, auth)).toBe(false);

        const tamperedAuths: TunnelAuth[] = [
            { ...auth, protocolVersions: [1] },
            { ...auth, protocolVersions: [1, 2, 4] },
            { ...auth, features: features('alpha') },
            { ...auth, features: features('alpha', 'beta', 'gamma') },
            { ...auth, features: [] },
            { ...auth, version: EngineVersion.parse('1.8.3') },
        ];
        for (const tampered of tamperedAuths) expect(verifyTunnelAuth(key, relayChallenge, tampered)).toBe(false);
    });

    it('warns when the relay does not accept the default hostname', async () => {
        const ctx = await setup();
        const { connection, auth, challenge: parsed } = await toAuth(ctx);
        connection.relayJson(honestReady(parsed, auth, ['custom.example.com']));
        expect(ctx.link.state().kind).toBe('ready');
        expect(ctx.logger.entries).toContainEqual({
            level: 'warn',
            event: 'tunnel.default-hostname-missing',
            fields: { relay: TARGET.url },
        });
    });

    it('never logs the signature, the nonce or the engine key', async () => {
        const ctx = await setup();
        const { auth, challenge: parsed } = await toReady(ctx);
        const logged = ctx.logger.text();
        expect(logged).not.toContain(auth.sig);
        expect(logged).not.toContain(parsed.nonce);
        expect(logged).not.toContain(encodeBase64Url(ctx.identity.publicKey));
    });
});

describe('downgrade protection', () => {
    const relayChallenge = () => challenge({ protocolVersions: [1, 2], features: features('alpha', 'gamma') });

    it.each([
        ['a lower common version', { protocolVersion: 1, features: ['alpha'] }],
        ['a missing shared feature', { protocolVersion: 2, features: [] }],
        ['an extra feature', { protocolVersion: 2, features: ['alpha', 'gamma'] }],
        ['a version the engine never offered', { protocolVersion: 3, features: ['alpha'] }],
    ])('closes with PROTOCOL_ERROR on a ready with %s', async (_name, choice) => {
        const ctx = await setup(WIDE_OFFER);
        const { connection } = await toAuth(ctx, relayChallenge());
        connection.relayJson({ v: 1, type: 'ready', hostnames: [ctx.ownHostname], ...choice });
        expect(connection.closeCodes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(events(ctx)).toContain('tunnel.downgrade-refused');
        expectBackoff(ctx, 1);
    });
});

describe('challenge checks', () => {
    it('closes without sending auth when the challenge names another relay', async () => {
        const ctx = await setup();
        const connection = await open(ctx);
        connection.relayJson(challenge({ relayId: 'relay-b.ptbk.test' }));
        await until(() => connection.closeCodes.length > 0);
        expect(connection.texts).toEqual([]);
        expect(connection.closeCodes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(ctx.logger.entries).toContainEqual({
            level: 'warn',
            event: 'tunnel.wrong-relay',
            fields: { relay: TARGET.url, attempt: 1 },
        });
        expect(ctx.logger.text()).not.toContain('relay-b');
        expectBackoff(ctx, 1);
    });

    it('closes and backs off on a challenge with an unknown field', async () => {
        const ctx = await setup();
        const connection = await open(ctx);
        connection.relayJson({ ...challenge(), extra: true });
        await flush();
        expect(connection.texts).toEqual([]);
        expect(connection.closeCodes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(ctx.logger.entries).toContainEqual({
            level: 'warn',
            event: 'tunnel.protocol-error',
            fields: { relay: TARGET.url, attempt: 1, reason: 'invalid-message' },
        });
        expectBackoff(ctx, 1);
    });

    it.each([
        ['a second challenge', 'unexpected-challenge'],
        ['a ready before auth', 'unexpected-ready'],
    ])('treats %s as a protocol error', async (_name, reason) => {
        const ctx = await setup();
        const connection = await open(ctx);
        if (reason === 'unexpected-challenge') {
            connection.relayJson(challenge());
            connection.relayJson(challenge());
        } else {
            connection.relayJson({ v: 1, type: 'ready', protocolVersion: 1, features: [], hostnames: ['a.b.test'] });
        }
        await flush(3);
        expect(connection.closeCodes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(ctx.logger.entries.find((entry) => entry.event === 'tunnel.protocol-error')?.fields).toMatchObject({
            reason,
        });
        expect(connection.texts).toEqual([]);
        expectBackoff(ctx, 1);
    });

    it('treats a binary frame before ready as a protocol error', async () => {
        const ctx = await setup();
        const connection = await open(ctx);
        connection.relayBinary(Uint8Array.of(2, 0, 0, 0, 1, 0));
        expect(connection.closeCodes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expectBackoff(ctx, 1);
    });

    it('backs off when the handshake times out, closing with AUTH_FAILED', async () => {
        const ctx = await setup();
        const { connection } = await toAuth(ctx);
        ctx.clock.advance(HANDSHAKE_TIMEOUT_MS - 1);
        expect(ctx.link.state().kind).toBe('handshaking');
        ctx.clock.advance(1);
        expect(connection.closeCodes).toEqual([TUNNEL_CLOSE_CODE.AUTH_FAILED]);
        expect(events(ctx)).toContain('tunnel.handshake-timeout');
        expectBackoff(ctx, 1);
    });

    it('fails closed when signing throws', async () => {
        const ctx = await setup();
        const failing: EngineIdentity = { ...ctx.identity, sign: () => Promise.reject(new TypeError('key gone')) };
        const link = createRelayLink({
            relay: TARGET,
            identity: failing,
            engineVersion: ENGINE_VERSION,
            offer: V1_OFFER,
            defaultHostname: ctx.ownHostname,
            dialer: ctx.dialer,
            clock: ctx.clock,
            random: createSeededRandom(SEED),
            logger: ctx.logger,
            onStream: () => noEvents,
        });
        link.start();
        const connection = ctx.dialer.last().open();
        await flush();
        connection.relayJson(challenge());
        await until(() => connection.closeCodes.length > 0);
        expect(connection.closeCodes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(ctx.logger.entries).toContainEqual({
            level: 'error',
            event: 'tunnel.sign-failed',
            fields: { relay: TARGET.url, attempt: 1, problem: 'TypeError' },
        });
        expect(link.state().kind).toBe('backoff');
    });
});

describe('reject and close handling', () => {
    const reasons: TunnelRejectReason[] = [
        'auth-failed',
        'suspended',
        'unsupported-version',
        'timeout',
        'rate-limited',
    ];

    it.each(reasons)('logs a %s reject, closes and backs off with jitter from the injected Random', async (reason) => {
        const ctx = await setup();
        const { connection } = await toAuth(ctx);
        connection.relayJson({ v: 1, type: 'reject', reason });
        expect(ctx.logger.entries).toContainEqual({
            level: 'warn',
            event: 'tunnel.rejected',
            fields: { relay: TARGET.url, attempt: 1, reason },
        });
        expect(connection.closeCodes).toEqual([1000]);
        const delay = expectBackoff(ctx, 1);
        connection.relayClose(reason === 'rate-limited' ? WS_CLOSE_TRY_AGAIN_LATER : TUNNEL_CLOSE_CODE.AUTH_FAILED);
        expect(ctx.dialer.dials).toHaveLength(1);
        ctx.clock.advance(delay);
        expect(ctx.dialer.dials).toHaveLength(2);
        expect(ctx.link.state()).toEqual({ kind: 'connecting', attempt: 2 });
    });

    it('accepts a reject while it is still signing', async () => {
        const ctx = await setup();
        const connection = await open(ctx);
        connection.relayJson(challenge());
        connection.relayJson({ v: 1, type: 'reject', reason: 'timeout' });
        await flush(5);
        expect(connection.texts).toEqual([]);
        expectBackoff(ctx, 1);
    });

    it('backs off normally when the relay closes during the handshake, even with SHUTTING_DOWN', async () => {
        const ctx = await setup();
        const connection = await open(ctx);
        connection.relayClose(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
        expect(ctx.logger.entries).toContainEqual({
            level: 'warn',
            event: 'tunnel.closed',
            fields: { relay: TARGET.url, attempt: 1, code: TUNNEL_CLOSE_CODE.SHUTTING_DOWN, phase: 'await-challenge' },
        });
        expectBackoff(ctx, 1);
    });

    it('backs off, escalating, when the relay closes malformed input with PROTOCOL_ERROR and no reject', async () => {
        const ctx = await setup();
        for (let attempt = 1; attempt <= 4; attempt++) {
            const { connection } = await toAuth(ctx);
            connection.relayClose(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
            expect(ctx.logger.entries.at(-2)).toEqual({
                level: 'warn',
                event: 'tunnel.closed',
                fields: { relay: TARGET.url, attempt, code: TUNNEL_CLOSE_CODE.PROTOCOL_ERROR, phase: 'await-ready' },
            });
            const delay = expectBackoff(ctx, attempt);
            expect(ctx.dialer.dials).toHaveLength(attempt);
            ctx.clock.advance(delay);
        }
        expect(events(ctx)).not.toContain('tunnel.rejected');
    });

    it('escalates the backoff over consecutive failures up to the cap', async () => {
        const ctx = await setup();
        ctx.link.start();
        for (let attempt = 1; attempt <= 8; attempt++) {
            ctx.dialer.last().fail({ reason: 'network' });
            await flush();
            const delay = expectBackoff(ctx, attempt);
            expect(delay).toBeLessThanOrEqual(BACKOFF_CAP_MS);
            ctx.clock.advance(delay);
            expect(ctx.link.state()).toEqual({ kind: 'connecting', attempt: attempt + 1 });
        }
    });

    it('logs a failed dial with its reason and status only', async () => {
        const ctx = await setup();
        ctx.link.start();
        ctx.dialer.last().fail({ reason: 'proxy-status', status: 407 });
        await flush();
        expect(ctx.logger.entries).toContainEqual({
            level: 'warn',
            event: 'tunnel.dial-failed',
            fields: { relay: TARGET.url, attempt: 1, reason: 'proxy-status', status: 407 },
        });
        expectBackoff(ctx, 1);
    });

    it('fails closed when the dialer throws', async () => {
        const ctx = await setup();
        ctx.link.start();
        ctx.dialer.last().reject(new RangeError('bug'));
        await flush();
        expect(ctx.logger.entries).toContainEqual({
            level: 'error',
            event: 'tunnel.dial-error',
            fields: { relay: TARGET.url, attempt: 1, problem: 'RangeError' },
        });
        expectBackoff(ctx, 1);
    });

    it('reconnects a lost tunnel', async () => {
        const ctx = await setup();
        const { connection } = await toReady(ctx);
        connection.relayClose(1006);
        const delay = expectBackoff(ctx, 1);
        ctx.clock.advance(delay);
        const second = await open(ctx);
        expect(ctx.dialer.dials).toHaveLength(2);
        second.relayJson(challenge());
        await until(() => second.texts.length === 1);
        expect(ctx.link.state()).toEqual({ kind: 'handshaking', attempt: 2 });
    });

    it('stops for good on REPLACED instead of reconnecting in a loop', async () => {
        const ctx = await setup();
        const { connection } = await toReady(ctx);
        connection.relayClose(TUNNEL_CLOSE_CODE.REPLACED);
        expect(ctx.link.state()).toEqual({ kind: 'stopped', reason: 'replaced' });
        expect(ctx.logger.entries).toContainEqual({
            level: 'error',
            event: 'tunnel.replaced',
            fields: { relay: TARGET.url },
        });
        ctx.clock.advance(10 * 60_000);
        expect(ctx.dialer.dials).toHaveLength(1);
    });

    it.each([
        ['SUSPENDED', TUNNEL_CLOSE_CODE.SUSPENDED],
        ['AUTH_FAILED', TUNNEL_CLOSE_CODE.AUTH_FAILED],
        ['1013', WS_CLOSE_TRY_AGAIN_LATER],
    ])('backs off normally after %s on a ready tunnel, without a tight loop', async (_name, code) => {
        const ctx = await setup();
        for (let attempt = 1; attempt <= 3; attempt++) {
            const { connection } = await toReady(ctx);
            connection.relayClose(code);
            const delay = expectBackoff(ctx, attempt);
            ctx.clock.advance(delay);
        }
    });

    it('retries a draining relay within 0–500 ms without counting a failure', async () => {
        const ctx = await setup();
        ctx.link.start();
        ctx.dialer.last().fail({ reason: 'network' });
        await flush();
        ctx.clock.advance(expectBackoff(ctx, 1));
        const { connection } = await toReady(ctx);
        connection.relayClose(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
        const state = ctx.link.state();
        if (state.kind !== 'backoff') throw new Error('expected backoff');
        expect(state.attempt).toBe(1);
        expect(state.delayMs).toBeLessThanOrEqual(SHUTTING_DOWN_JITTER_MS);
        ctx.clock.advance(state.delayMs);
        expect(ctx.dialer.dials).toHaveLength(3);
    });

    it('restarts the backoff after a tunnel that was healthy for 60 s, and keeps escalating otherwise', async () => {
        const ctx = await setup();
        ctx.link.start();
        for (let attempt = 1; attempt <= 3; attempt++) {
            ctx.dialer.last().fail({ reason: 'network' });
            await flush();
            ctx.clock.advance(expectBackoff(ctx, attempt));
        }

        const brief = await toReady(ctx);
        ctx.clock.advance(HEALTHY_RESET_MS - 1);
        brief.connection.relayClose(1006);
        ctx.clock.advance(expectBackoff(ctx, 4));

        const healthy = await toReady(ctx);
        ctx.clock.advance(HEALTHY_RESET_MS);
        healthy.connection.relayClose(1006);
        expectBackoff(ctx, 1);
    });
});

describe('streams', () => {
    const open4 = (id: number) =>
        encodeFrame({
            type: FrameType.OPEN,
            streamId: StreamId.parse(id),
            family: 4,
            address: Uint8Array.of(203, 0, 113, 7),
            port: 50_000,
        });

    it('hands streams the relay opens to the consumer and sends their frames over the tunnel', async () => {
        const ctx = await setup();
        const { connection } = await toReady(ctx);
        connection.relayBinary(open4(1));
        expect(ctx.streams).toHaveLength(1);
        const stream = ctx.streams[0];
        expect(stream?.remote).toEqual({ family: 'IPv4', address: '203.0.113.7', port: 50_000 });
        stream?.close(CLOSE_CODE.REFUSED);
        expect(connection.binaries).toEqual([
            encodeFrame({ type: FrameType.CLOSE, streamId: StreamId.parse(1), code: CLOSE_CODE.REFUSED }),
        ]);
    });

    it('closes the tunnel with PROTOCOL_ERROR on an invalid frame and ends every stream', async () => {
        const ctx = await setup();
        const { connection } = await toReady(ctx);
        connection.relayBinary(open4(1));
        expect(ctx.link.state().kind).toBe('ready');
        connection.relayBinary(Uint8Array.of(0x7f, 0, 0, 0, 1));
        expect(connection.closeCodes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(ctx.logger.entries.find((entry) => entry.event === 'tunnel.protocol-error')?.fields).toMatchObject({
            reason: 'unknown-type',
        });
        expect(ctx.streams[0]?.isOpen()).toBe(false);
        expectBackoff(ctx, 1);
    });

    it('treats a text message after ready as a protocol error', async () => {
        const ctx = await setup();
        const { connection } = await toReady(ctx);
        connection.relayJson({ v: 1, type: 'reject', reason: 'suspended' });
        expect(connection.closeCodes).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(ctx.logger.entries.find((entry) => entry.event === 'tunnel.protocol-error')?.fields).toMatchObject({
            reason: 'unexpected-reject',
        });
    });
});

describe('stop', () => {
    it('closes a ready tunnel with 1001 and resolves once the socket closed', async () => {
        const ctx = await setup();
        const { connection } = await toReady(ctx);
        let stopped = false;
        const stopping = ctx.link.stop().then(() => {
            stopped = true;
        });
        expect(connection.closeCodes).toEqual([1001]);
        expect(ctx.link.state()).toEqual({ kind: 'stopped', reason: 'requested' });
        await flush();
        expect(stopped).toBe(false);
        connection.relayClose(1001);
        await stopping;
        ctx.clock.advance(60_000);
        expect(ctx.dialer.dials).toHaveLength(1);
        await ctx.link.stop();
    });

    it('gives up waiting for the close after STOP_TIMEOUT_MS', async () => {
        const ctx = await setup();
        await toAuth(ctx);
        const stopping = ctx.link.stop();
        ctx.clock.advance(STOP_TIMEOUT_MS);
        await stopping;
        expect(ctx.link.state().kind).toBe('stopped');
    });

    it('cancels a pending retry', async () => {
        const ctx = await setup();
        ctx.link.start();
        ctx.dialer.last().fail({ reason: 'timeout' });
        await flush();
        await ctx.link.stop();
        ctx.clock.advance(60_000);
        expect(ctx.dialer.dials).toHaveLength(1);
        expect(ctx.clock.pendingTimers()).toBe(0);
    });

    it('aborts a dial in progress and closes a socket that opens late', async () => {
        const ctx = await setup();
        ctx.link.start();
        const dial = ctx.dialer.last();
        await ctx.link.stop();
        expect(dial.signal.aborted).toBe(true);
        const late = dial.open();
        await flush();
        expect(late.closeCodes).toEqual([1001]);
        late.relayJson(challenge());
        late.relayClose(1006);
        await flush();
        expect(late.texts).toEqual([]);
        expect(ctx.link.state().kind).toBe('stopped');
    });

    it('stops from idle, and start after stop does nothing', async () => {
        const ctx = await setup();
        await ctx.link.stop();
        ctx.link.start();
        expect(ctx.dialer.dials).toHaveLength(0);
    });

    it('ignores a second start and events from an attempt it already gave up on', async () => {
        const ctx = await setup();
        const { connection } = await toAuth(ctx);
        ctx.link.start();
        expect(ctx.dialer.dials).toHaveLength(1);
        connection.relayJson({ v: 1, type: 'reject', reason: 'timeout' });
        const bytes: Bytes = Uint8Array.of(1, 2, 3);
        connection.relayBinary(bytes);
        connection.relayJson(challenge());
        connection.relayClose(1006);
        expect(connection.closeCodes).toEqual([1000]);
        expectBackoff(ctx, 1);
    });
});
