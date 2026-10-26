import * as http from 'node:http';
import type * as net from 'node:net';
import { Duplex } from 'node:stream';
import * as tls from 'node:tls';

import type { Bytes, Frame, Hostname, TunnelAuth, TunnelChallenge } from '@ptbk/protocol';
import {
    CLOSE_CODE,
    EngineVersion,
    FrameType,
    INITIAL_WINDOW_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    MAX_WINDOW_INCREMENT,
    RelayId,
    StreamId,
    SIGNING_CONTEXT,
    TUNNEL_CLOSE_CODE,
    TUNNEL_PROTOCOL_VERSIONS,
    TUNNEL_SUBPROTOCOL,
    TunnelFeature,
    checkTunnelReady,
    createWebCryptoSigner,
    decodeBase64Url,
    decodeFrame,
    defaultHostname,
    deriveEngineId,
    ed25519SignatureFromBytes,
    encodeFrame,
    generateEd25519KeyPair,
    parseRelayMessage,
    signTunnelAuth,
    signingInput,
} from '@ptbk/protocol';
import type { Signer } from '@ptbk/protocol';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';

import { createTestCa } from '../pki/test-ca';
import type { TunnelEngine } from '../tunnel/runtime';

/*
 * An in-process tunnel client for the suite's own tests: correct by default, and each defect breaks one rule a check
 * must catch. Built on @ptbk/protocol where it is right and on hand-rolled code where a defect needs it to be wrong.
 */

export const TUNNEL_DEFECTS = [
    'wrong-subprotocol',
    'dial-only-first',
    'one-handshake-at-a-time',
    'duplicate-tunnels',
    'skip-relay-verification',
    'wrong-key',
    'reuse-first-auth',
    'omit-version',
    'unsorted-lists',
    'ignore-relay-id',
    'accept-any-ready',
    'ignore-invalid-messages',
    'tls12-only',
    'default-certificate',
    'max-four-streams',
    'ignore-window',
    'never-grant',
    'no-close-frame',
    'ignore-relay-close',
    'fail-on-ignorable',
    'oversized-frames',
    'no-ping',
    'ignore-unknown-types',
    'crash-on-malformed',
    'allow-duplicate-open',
    'stop-after-close',
    'stop-after-reject',
    'tight-loop',
    'reconnect-after-replaced',
    'ignore-proxy',
    'silent-challenge',
    'close-on-challenge',
    'garbage-auth',
    'other-identity',
    'version-2-only',
    'refuse-unknown-features',
    'silent-wrong-relay',
    'wrong-close-code',
    'lenient-challenge',
    'wrong-certificate-name',
    'refuse-streams',
    'wrong-api-answer',
    'no-http-answer',
    'ignore-window-frames',
    'auth-again-after-reject',
    'proxy-no-credentials',
    'ignore-no-proxy',
    'leak-proxy-password',
    'engine-opens-stream',
    'overgrant',
    'text-after-ready',
    'frame-for-unknown-stream',
    'ignorable-from-engine',
    'close-tunnel-on-bad-sni',
    'fail-on-late-frame',
] as const;
export type TunnelDefect = (typeof TUNNEL_DEFECTS)[number];

export interface FakeTunnelEngineOptions {
    readonly relayUrls: readonly string[];
    /** The CA the engine trusts for relay certificates. */
    readonly relayCaPem: string;
    readonly engineDomain: Hostname;
    readonly defects?: readonly TunnelDefect[];
    /** What the engine offers in `auth`; v1's lists by default. */
    readonly offer?: { readonly protocolVersions: readonly number[]; readonly features: readonly string[] };
    readonly pingIntervalMs?: number;
    readonly backoffBaseMs?: number;
    readonly backoffCapMs?: number;
    readonly env?: Readonly<Record<string, string>>;
}

export interface FakeTunnelEngine extends TunnelEngine {
    readonly engineId: string;
    stop(): Promise<void>;
}

const VERSION = EngineVersion.parse('1.2.3');

function randomBelow(max: number): number {
    const [value = 0] = crypto.getRandomValues(new Uint32Array(1));
    return Math.floor((value / 2 ** 32) * max);
}

function toBytes(data: RawData): Bytes {
    return new Uint8Array(data as Buffer);
}

interface EngineCertificates {
    readonly caPem: string;
    readonly hostname: Hostname;
    readonly context: tls.SecureContext;
    /** No certificate: what a ClientHello without SNI meets. */
    readonly empty: tls.SecureContext;
}

/** The engine side of one stream, as a Duplex a TLS server can run on. */
class EngineStream extends Duplex {
    readonly id: StreamId;
    #sendCredit = INITIAL_WINDOW_BYTES;
    #receiveCredit = INITIAL_WINDOW_BYTES;
    #open = true;
    readonly #pending: { chunk: Buffer; callback: (error?: Error | null) => void }[] = [];
    readonly #link: Link;

    constructor(link: Link, id: StreamId) {
        super({ allowHalfOpen: true });
        this.#link = link;
        this.id = id;
    }

    isOpen(): boolean {
        return this.#open;
    }

    /** False when the relay overran the credit. */
    onData(payload: Bytes): boolean {
        this.#receiveCredit -= payload.length;
        if (this.#receiveCredit < 0) return false;
        if (this.#open) this.push(Buffer.from(payload));
        if (!this.#link.has('never-grant') && this.#open) {
            this.#receiveCredit += payload.length;
            this.#link.send({ type: FrameType.WINDOW, streamId: this.id, increment: payload.length });
        }
        return true;
    }

    onWindow(increment: number): void {
        this.#sendCredit += increment;
        this.#pump();
    }

    onRelayClose(): void {
        if (this.#link.has('ignore-relay-close')) return;
        this.#open = false;
        this.push(null);
        for (const { callback } of this.#pending.splice(0)) callback();
        this.destroy();
    }

    override _read(): void {
        // Credit goes back per frame received.
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (!this.#open) {
            callback();
            return;
        }
        this.#pending.push({ chunk, callback });
        this.#pump();
    }

    override _final(callback: (error?: Error | null) => void): void {
        this.#closeFromEngine();
        callback();
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.#closeFromEngine();
        callback(error);
    }

    #closeFromEngine(): void {
        if (!this.#open) return;
        this.#open = false;
        if (!this.#link.has('no-close-frame')) {
            this.#link.send({ type: FrameType.CLOSE, streamId: this.id, code: CLOSE_CODE.NORMAL });
        }
    }

    #pump(): void {
        const ignoreWindow = this.#link.has('ignore-window');
        const maxFrame = MAX_FRAME_PAYLOAD_BYTES;
        while (this.#open || this.#link.has('ignore-relay-close')) {
            const head = this.#pending[0];
            if (head === undefined) return;
            const credit = ignoreWindow ? Number.MAX_SAFE_INTEGER : this.#sendCredit;
            const size = Math.min(head.chunk.length, maxFrame, credit);
            if (size <= 0) return;
            this.#sendCredit -= size;
            const payload = new Uint8Array(head.chunk.subarray(0, size));
            this.#link.send({ type: FrameType.DATA, streamId: this.id, payload });
            if (size === head.chunk.length) {
                this.#pending.shift();
                head.callback();
            } else {
                head.chunk = head.chunk.subarray(size);
            }
        }
    }
}

function rawData(streamId: number, payload: Bytes): Uint8Array {
    const bytes = new Uint8Array(5 + payload.length);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, FrameType.DATA);
    view.setUint32(1, streamId);
    bytes.set(payload, 5);
    return bytes;
}

/** Signs `auth` the way a defect says, or correctly. */
async function signAuth(
    engine: FakeEngineState,
    challenge: TunnelChallenge,
    dialled: RelayId,
): Promise<TunnelAuth | null> {
    const offer = {
        version: VERSION,
        protocolVersions: engine.defects.has('version-2-only') ? [2] : [...engine.offer.protocolVersions],
        features: TunnelFeature.array().parse(engine.offer.features),
    };
    const dialledRelayId = engine.defects.has('ignore-relay-id') ? challenge.relayId : dialled;
    if (engine.defects.has('other-identity')) {
        const other = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
        const signedByOther = await signTunnelAuth(other, challenge, offer, { dialledRelayId });
        return signedByOther.kind === 'signed' ? signedByOther.auth : null;
    }
    const signed = await signTunnelAuth(engine.signer, challenge, offer, { dialledRelayId });
    if (signed.kind === 'wrong-relay') return null;
    const { auth } = signed;
    const custom = async (parts: readonly (string | Bytes)[], signer: Signer = engine.signer): Promise<TunnelAuth> => ({
        ...auth,
        sig: ed25519SignatureFromBytes(await signer.sign(signingInput(SIGNING_CONTEXT.tunnel, ...parts))),
    });
    const nonce = decodeBase64Url(challenge.nonce);
    if (nonce.kind === 'invalid') return null;
    const base = [challenge.relayId, nonce.bytes, auth.engineId] as const;
    if (engine.defects.has('wrong-key')) {
        const other = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
        return custom(
            [...base, auth.version, challenge.protocolVersions.join(','), challenge.features.join(','), '1', ''],
            other,
        );
    }
    if (engine.defects.has('omit-version')) {
        return custom([
            ...base,
            [...challenge.protocolVersions].sort((a, b) => a - b).join(','),
            [...challenge.features].sort().join(','),
            '1',
            '',
        ]);
    }
    if (engine.defects.has('unsorted-lists')) {
        return custom([
            ...base,
            auth.version,
            challenge.protocolVersions.join(','),
            challenge.features.join(','),
            '1',
            '',
        ]);
    }
    if (engine.defects.has('reuse-first-auth')) {
        engine.firstAuth ??= auth;
        return engine.firstAuth;
    }
    return auth;
}

interface FakeEngineState {
    readonly api: http.Server;
    readonly offer: { readonly protocolVersions: readonly number[]; readonly features: readonly string[] };
    readonly signer: Signer;
    readonly defects: ReadonlySet<TunnelDefect>;
    readonly certificates: EngineCertificates;
    firstAuth: TunnelAuth | null;
    /** A link in its handshake, for the defect that lets only one handshake run at a time. */
    handshaking: Link | null;
}

/** One relay's tunnel with reconnects, as an engine runs it. */
class Link {
    readonly relayUrl: URL;
    readonly #engine: FakeEngineState;
    readonly #options: FakeTunnelEngineOptions & { readonly env: Readonly<Record<string, string>> };
    #ws: WebSocket | null = null;
    #stopped = false;
    #failures = 0;
    #timer: ReturnType<typeof setTimeout> | null = null;
    readonly #streams = new Map<number, EngineStream>();
    #highestStream = 0;

    constructor(
        engine: FakeEngineState,
        relayUrl: string,
        options: FakeTunnelEngineOptions & { readonly env: Readonly<Record<string, string>> },
    ) {
        this.#engine = engine;
        this.relayUrl = new URL(relayUrl);
        this.#options = options;
    }

    has(defect: TunnelDefect): boolean {
        return this.#engine.defects.has(defect);
    }

    start(): void {
        void this.#connect();
    }

    stop(): void {
        this.#stopped = true;
        if (this.#timer !== null) clearTimeout(this.#timer);
        this.#ws?.terminate();
    }

    send(frame: Frame): void {
        this.sendRaw(encodeFrame(frame));
    }

    sendRaw(bytes: Uint8Array): void {
        if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(bytes, { binary: true });
    }

    #retry(kind: 'backoff' | 'fast' | 'stop'): void {
        this.#ws = null;
        for (const stream of this.#streams.values()) stream.destroy();
        this.#streams.clear();
        this.#highestStream = 0;
        if (this.#stopped || kind === 'stop') return;
        const base = this.#options.backoffBaseMs ?? 50;
        const cap = this.#options.backoffCapMs ?? 500;
        const delay = this.has('tight-loop')
            ? 0
            : kind === 'fast'
              ? randomBelow(base)
              : randomBelow(Math.min(cap, base * 2 ** this.#failures) + 1);
        if (kind === 'backoff') this.#failures++;
        this.#timer = setTimeout(() => {
            void this.#connect();
        }, delay);
    }

    async #socket(): Promise<tls.TLSSocket> {
        const { hostname } = this.relayUrl;
        const port = Number(this.relayUrl.port || '443');
        const proxy = this.#options.env['HTTPS_PROXY'];
        const bypass =
            !this.has('ignore-no-proxy') && (this.#options.env['NO_PROXY'] ?? '').split(',').includes(hostname);
        const tlsOptions = {
            servername: hostname,
            ca: [this.#options.relayCaPem],
            rejectUnauthorized: !this.has('skip-relay-verification'),
        };
        if (proxy === undefined || bypass || this.has('ignore-proxy')) {
            return tls.connect({ host: hostname, port, ...tlsOptions });
        }
        const proxyUrl = new URL(proxy);
        const auth = Buffer.from(
            `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
        ).toString('base64');
        const raw = await new Promise<net.Socket>((resolve, reject) => {
            const request = http.request({
                host: proxyUrl.hostname,
                port: Number(proxyUrl.port),
                method: 'CONNECT',
                path: `${hostname}:${String(port)}`,
                headers: this.has('proxy-no-credentials') ? {} : { 'Proxy-Authorization': `Basic ${auth}` },
            });
            request.once('connect', (response, socket) => {
                if (response.statusCode === 200) resolve(socket);
                else reject(new Error('proxy refused'));
            });
            request.once('error', reject);
            request.end();
        });
        return tls.connect({ socket: raw, ...tlsOptions });
    }

    async #connect(): Promise<void> {
        if (this.#stopped) return;
        const busy = this.#engine.handshaking;
        if (this.has('one-handshake-at-a-time') && busy !== null && busy !== this) {
            this.#timer = setTimeout(() => void this.#connect(), 20);
            return;
        }
        this.#engine.handshaking = this;
        let socket: tls.TLSSocket;
        try {
            socket = await this.#socket();
        } catch {
            if (this.#engine.handshaking === this) this.#engine.handshaking = null;
            this.#retry('backoff');
            return;
        }
        socket.on('error', () => undefined);
        const protocol = this.has('wrong-subprotocol') ? `${TUNNEL_SUBPROTOCOL}-v1` : TUNNEL_SUBPROTOCOL;
        const ws = new WebSocket(this.relayUrl, [protocol], {
            createConnection: () => socket,
            perMessageDeflate: false,
            maxPayload: this.has('oversized-frames') ? 1 << 20 : 5 + MAX_FRAME_PAYLOAD_BYTES,
        });
        this.#ws = ws;
        let phase: 'challenge' | 'ready' | 'live' = 'challenge';
        let challenge: TunnelChallenge | null = null;
        let auth: TunnelAuth | null = null;
        let rejected = false;
        let pinger: ReturnType<typeof setInterval> | null = null;
        const fail = (code: number): void => {
            if (ws.readyState === WebSocket.OPEN) ws.close(this.has('wrong-close-code') ? 1002 : code);
        };
        ws.on('error', () => undefined);
        ws.on('open', () => {
            if (!this.has('no-ping')) {
                pinger = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.ping();
                }, this.#options.pingIntervalMs ?? 25_000);
            }
        });
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                if (phase !== 'live') {
                    if (!this.has('ignore-invalid-messages')) fail(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                    return;
                }
                this.#onFrame(toBytes(data), fail);
                return;
            }
            const text = (data as Buffer).toString('utf8');
            let parsed = parseRelayMessage(text);
            if (parsed.kind === 'invalid' && this.has('lenient-challenge')) {
                const loose = JSON.parse(text) as Record<string, unknown>;
                const { v, type, nonce, relayId, protocolVersions, features } = loose;
                parsed = parseRelayMessage(JSON.stringify({ v, type, nonce, relayId, protocolVersions, features }));
            }
            if (parsed.kind === 'invalid') {
                if (!this.has('ignore-invalid-messages')) fail(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                return;
            }
            const message = parsed.message;
            if (message.type === 'reject') {
                rejected = true;
                if (this.has('auth-again-after-reject') && auth !== null) ws.send(JSON.stringify(auth));
                ws.close(1000);
                return;
            }
            if (message.type === 'challenge' && phase === 'challenge') {
                challenge = message;
                phase = 'ready';
                if (this.has('silent-challenge')) return;
                if (this.has('close-on-challenge')) {
                    ws.close(1000);
                    return;
                }
                if (this.has('garbage-auth')) {
                    ws.send('{"v":1,"type":"auth"}');
                    return;
                }
                if (this.has('refuse-unknown-features') && message.features.length > 0) {
                    fail(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                    return;
                }
                void signAuth(this.#engine, message, RelayId.parse(this.relayUrl.hostname)).then((signed) => {
                    if (signed === null) {
                        if (!this.has('silent-wrong-relay')) fail(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                        return;
                    }
                    auth = signed;
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(signed));
                });
                return;
            }
            if (message.type === 'ready' && phase === 'ready' && challenge !== null && auth !== null) {
                if (!this.has('accept-any-ready') && checkTunnelReady(challenge, auth, message).kind !== 'ok') {
                    fail(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                    return;
                }
                phase = 'live';
                this.#failures = 0;
                if (this.#engine.handshaking === this) this.#engine.handshaking = null;
                this.#misbehaveAfterReady(ws);
                return;
            }
            if (!this.has('ignore-invalid-messages')) fail(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
        });
        ws.once('close', (code) => {
            if (pinger !== null) clearInterval(pinger);
            if (this.#engine.handshaking === this) this.#engine.handshaking = null;
            if (this.#ws !== ws) return;
            if (rejected) {
                this.#retry(this.has('stop-after-reject') ? 'stop' : 'backoff');
                return;
            }
            if (phase !== 'live') {
                this.#retry('backoff');
                return;
            }
            if (this.has('stop-after-close')) this.#retry('stop');
            else if (code === TUNNEL_CLOSE_CODE.REPLACED)
                this.#retry(this.has('reconnect-after-replaced') ? 'backoff' : 'stop');
            else if (code === TUNNEL_CLOSE_CODE.SHUTTING_DOWN) this.#retry('fast');
            else this.#retry('backoff');
        });
    }

    /** The rules an engine can break with what it sends once a tunnel is ready. */
    #misbehaveAfterReady(ws: WebSocket): void {
        if (this.has('text-after-ready')) ws.send('{"v":1}');
        if (this.has('engine-opens-stream')) {
            this.send({
                type: FrameType.OPEN,
                streamId: StreamId.parse(1),
                family: 4,
                address: Uint8Array.of(127, 0, 0, 1),
                port: 1,
            });
        }
        if (this.has('frame-for-unknown-stream'))
            this.send({ type: FrameType.WINDOW, streamId: StreamId.parse(999), increment: 1 });
        if (this.has('ignorable-from-engine')) this.sendRaw(Uint8Array.of(0x85, 0, 0, 0, 1));
    }

    #onFrame(bytes: Bytes, fail: (code: number) => void): void {
        const decoded = decodeFrame(bytes);
        if (decoded.kind === 'ignored') {
            if (this.has('fail-on-ignorable')) fail(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
            return;
        }
        if (decoded.kind === 'invalid') {
            if (this.has('crash-on-malformed') && decoded.reason !== 'unknown-type' && decoded.reason !== 'bad-flags') {
                this.#engineCrash();
                return;
            }
            if (
                this.has('ignore-unknown-types') &&
                (decoded.reason === 'unknown-type' || decoded.reason === 'bad-flags')
            ) {
                return;
            }
            fail(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
            return;
        }
        const frame = decoded.frame;
        const lax = this.has('allow-duplicate-open');
        if (frame.type === FrameType.OPEN) {
            if (!lax && frame.streamId <= this.#highestStream) {
                fail(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                return;
            }
            this.#highestStream = Math.max(this.#highestStream, frame.streamId);
            this.#open(frame.streamId);
            return;
        }
        const stream = this.#streams.get(frame.streamId);
        if (stream === undefined) {
            const late = frame.streamId <= this.#highestStream;
            if (!lax && (!late || this.has('fail-on-late-frame'))) fail(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
            return;
        }
        switch (frame.type) {
            case FrameType.DATA:
                if (!stream.onData(frame.payload)) {
                    this.send({ type: FrameType.CLOSE, streamId: frame.streamId, code: CLOSE_CODE.FLOW_CONTROL });
                    fail(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                }
                return;
            case FrameType.WINDOW:
                if (!this.has('ignore-window-frames')) stream.onWindow(frame.increment);
                return;
            case FrameType.CLOSE:
                if (!this.has('ignore-relay-close')) this.#streams.delete(frame.streamId);
                stream.onRelayClose();
                return;
        }
    }

    #engineCrash(): void {
        this.#onCrash();
    }

    #onCrash: () => void = () => undefined;

    set onCrash(handler: () => void) {
        this.#onCrash = handler;
    }

    #open(id: StreamId): void {
        if (this.has('refuse-streams') || (this.has('max-four-streams') && this.#streams.size >= 4)) {
            this.send({ type: FrameType.CLOSE, streamId: id, code: CLOSE_CODE.REFUSED });
            return;
        }
        const stream = new EngineStream(this, id);
        this.#streams.set(id, stream);
        if (this.has('oversized-frames')) this.sendRaw(rawData(id, new Uint8Array(MAX_FRAME_PAYLOAD_BYTES + 1)));
        if (this.has('overgrant')) this.send({ type: FrameType.WINDOW, streamId: id, increment: MAX_WINDOW_INCREMENT });
        stream.on('error', () => undefined);
        const { certificates } = this.#engine;
        const secure = new tls.TLSSocket(stream, {
            isServer: true,
            ALPNProtocols: ['http/1.1'],
            SNICallback: (servername, callback) => {
                if (servername === certificates.hostname || this.has('default-certificate')) {
                    callback(null, certificates.context);
                } else {
                    if (this.has('close-tunnel-on-bad-sni')) this.#ws?.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                    callback(new Error('unknown hostname'));
                }
            },
            secureContext: this.has('default-certificate') ? certificates.context : certificates.empty,
        });
        secure.on('error', () => {
            stream.destroy();
        });
        secure.once('secure', () => {
            if (!this.has('no-http-answer')) this.#engine.api.emit('connection', secure);
        });
        secure.once('close', () => stream.destroy());
    }
}

/** Answers the engine API's 401 for anything, the contract's answer without a session. */
function createApiServer(defects: ReadonlySet<TunnelDefect>): http.Server {
    const server = http.createServer((request, response) => {
        request.resume();
        // Two test paths for the tunnel fetch: an answer without a body, and one that never comes.
        if (request.url === '/__fake/no-content') {
            response.writeHead(204).end();
            return;
        }
        if (request.url === '/__fake/hang') return;
        if (defects.has('wrong-api-answer')) {
            response.writeHead(200, { 'content-type': 'text/plain', 'content-length': 5 });
            response.end('hello');
            return;
        }
        const body = JSON.stringify({
            type: 'https://ptbk.io/problems/unauthenticated',
            title: 'Unauthenticated',
            status: 401,
            code: 'unauthenticated',
        });
        response.writeHead(401, {
            'content-type': 'application/problem+json',
            'content-length': Buffer.byteLength(body),
        });
        response.end(body);
    });
    server.on('clientError', (_error, socket) => {
        socket.destroy();
    });
    return server;
}

/** Starts a fake engine dialling `relayUrls`; resolves once its identity exists (it dials in the background). */
export async function startFakeTunnelEngine(options: FakeTunnelEngineOptions): Promise<FakeTunnelEngine> {
    const signer = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
    const engineId = await deriveEngineId(signer.publicKey());
    const hostname = defaultHostname(engineId, options.engineDomain);
    const ca = createTestCa('fake engine ca', { permittedDomains: ['localhost'] });
    const leaf = ca.issue([
        options.defects?.includes('wrong-certificate-name') === true ? `other.${options.engineDomain}` : hostname,
    ]);
    const defects = new Set(options.defects ?? []);
    const versions = defects.has('tls12-only')
        ? { minVersion: 'TLSv1.2' as const, maxVersion: 'TLSv1.2' as const }
        : { minVersion: 'TLSv1.3' as const };
    const state: FakeEngineState = {
        api: createApiServer(defects),
        offer: options.offer ?? { protocolVersions: TUNNEL_PROTOCOL_VERSIONS, features: [] },
        signer,
        defects,
        certificates: {
            caPem: ca.certPem,
            hostname,
            context: tls.createSecureContext({ cert: leaf.certPem, key: leaf.keyPem, ...versions }),
            empty: tls.createSecureContext(versions),
        },
        firstAuth: null,
        handshaking: null,
    };
    let env: Readonly<Record<string, string>> = options.env ?? {};
    let links: Link[] = [];
    let running = true;

    const start = (): void => {
        running = true;
        const urls = state.defects.has('dial-only-first') ? options.relayUrls.slice(0, 1) : options.relayUrls;
        const extra = state.defects.has('duplicate-tunnels') ? options.relayUrls.slice(0, 1) : [];
        links = [...urls, ...extra].map((url) => {
            const link = new Link(state, url, { ...options, env });
            link.onCrash = () => {
                for (const each of links) each.stop();
                running = false;
            };
            return link;
        });
        for (const link of links) link.start();
    };
    const stop = (): Promise<void> => {
        for (const link of links) link.stop();
        links = [];
        running = false;
        return Promise.resolve();
    };
    start();

    return {
        engineId,
        enginePublicKey: signer.publicKey(),
        async restart(patch) {
            await stop();
            const merged = { ...env, ...patch };
            env = Object.fromEntries(
                Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== null),
            );
            state.firstAuth = null;
            start();
        },
        running: () => running,
        // Only what a careless engine would write: the proxy URL, credentials and all.
        logs: () =>
            state.defects.has('leak-proxy-password') ? `dialling via ${env['HTTPS_PROXY'] ?? 'no proxy'}` : '',
        certificateAuthority: () => Promise.resolve(state.certificates.caPem),
        stop,
    };
}
