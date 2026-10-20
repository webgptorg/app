import { once } from 'node:events';
import * as https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';

import type { Bytes, EngineId, Hostname, RelayId, TunnelChallenge, TunnelFeature, TunnelReady } from '@ptbk/protocol';
import {
    TUNNEL_CLOSE_CODE,
    TUNNEL_FEATURES,
    TUNNEL_PATH,
    TUNNEL_PROTOCOL_VERSIONS,
    TUNNEL_SUBPROTOCOL,
    TunnelChallenge as TunnelChallengeSchema,
    TunnelFeature as TunnelFeatureSchema,
    encodeBase64Url,
    negotiateTunnel,
    parseEngineMessage,
    verifyTunnelAuth,
} from '@ptbk/protocol';
import type { RawData, WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

export interface FakeRegistryEntry {
    readonly publicKey: Bytes;
    readonly hostnames: readonly Hostname[];
}

export interface FakeRelayOptions {
    readonly relayId: RelayId;
    readonly tls: { readonly certPem: string; readonly keyPem: string };
    readonly registry: (engineId: EngineId) => FakeRegistryEntry | undefined;
    readonly protocolVersions?: readonly number[];
    readonly features?: readonly TunnelFeature[];
    /** 0 (default) picks a free port; pass a previous relay's port to "restart" it. */
    readonly port?: number;
    /** `false` stops answering WebSocket pings, to test the engine's pong deadline. */
    readonly autoPong?: boolean;
}

/** A tunnel that reached `ready`, seen from the relay side. */
export interface FakeRelaySession {
    readonly engineId: EngineId;
    readonly ready: TunnelReady;
    sendBinary(bytes: Uint8Array): void;
    /** Binary messages received before a handler is set are queued and delivered to the first one. */
    onBinary(handler: (bytes: Bytes) => void): void;
    sendText(text: string): void;
    close(code: number): void;
    /** The close code the relay saw. */
    readonly closed: Promise<number>;
}

export interface FakeRelay {
    readonly port: number;
    /** `wss://<relayId>:<port>/v1/tunnel`. */
    readonly url: string;
    /** WebSocket connections accepted so far, including failed handshakes. */
    connections(): number;
    /** Sessions currently in `ready`. */
    sessions(): number;
    /** The next session to reach `ready` (or one that did and was not taken yet). */
    waitForSession(): Promise<FakeRelaySession>;
    /** Destroys every socket without a close frame and stops listening, like a crashed relay. */
    kill(): Promise<void>;
    /** Test teardown; same as `kill`. */
    close(): Promise<void>;
}

// `binaryType` stays 'nodebuffer', so ws hands over one Buffer per message.
function toBytes(data: RawData): Bytes {
    return new Uint8Array(data as Buffer);
}

/**
 * An in-test relay speaking C-02 over real TLS: challenge, `verifyTunnelAuth` against the challenge it sent and the
 * registry key, then `ready` from `negotiateTunnel`. Stands in for R-03 until it exists.
 */
export async function startFakeRelay(options: FakeRelayOptions): Promise<FakeRelay> {
    const versions = options.protocolVersions ?? TUNNEL_PROTOCOL_VERSIONS;
    const features = options.features ?? TunnelFeatureSchema.array().parse(TUNNEL_FEATURES);
    const sockets = new Set<Socket>();
    const live = new Set<FakeRelaySession>();
    const unclaimed: FakeRelaySession[] = [];
    const waiters: ((session: FakeRelaySession) => void)[] = [];
    let accepted = 0;

    const server = https.createServer({ cert: options.tls.certPem, key: options.tls.keyPem });
    server.on('connection', (socket: Socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.on('tlsClientError', () => undefined);
    const wss = new WebSocketServer({
        server,
        path: TUNNEL_PATH,
        autoPong: options.autoPong ?? true,
        handleProtocols: (protocols) => (protocols.has(TUNNEL_SUBPROTOCOL) ? TUNNEL_SUBPROTOCOL : false),
    });

    function publish(session: FakeRelaySession): void {
        const waiter = waiters.shift();
        if (waiter === undefined) unclaimed.push(session);
        else waiter(session);
    }

    function startSession(ws: WebSocket, engineId: EngineId, ready: TunnelReady): void {
        const queued: Bytes[] = [];
        let handler: ((bytes: Bytes) => void) | undefined;
        let resolveClosed: (code: number) => void = () => undefined;
        const closed = new Promise<number>((resolve) => {
            resolveClosed = resolve;
        });
        const session: FakeRelaySession = {
            engineId,
            ready,
            sendBinary: (bytes) => {
                ws.send(bytes, { binary: true });
            },
            onBinary(next) {
                handler = next;
                for (const bytes of queued.splice(0)) next(bytes);
            },
            sendText: (text) => {
                ws.send(text);
            },
            close: (code) => {
                ws.close(code);
            },
            closed,
        };
        ws.on('message', (data, isBinary) => {
            if (!isBinary) {
                ws.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                return;
            }
            const bytes = toBytes(data);
            if (handler === undefined) queued.push(bytes);
            else handler(bytes);
        });
        ws.once('close', (code) => {
            live.delete(session);
            resolveClosed(code);
        });
        live.add(session);
        publish(session);
    }

    wss.on('connection', (ws) => {
        accepted++;
        ws.on('error', () => undefined);
        const challenge: TunnelChallenge = TunnelChallengeSchema.parse({
            v: 1,
            type: 'challenge',
            nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
            relayId: options.relayId,
            protocolVersions: [...versions],
            features: [...features],
        });
        const reject = (reason: 'auth-failed' | 'unsupported-version', code: number): void => {
            ws.send(JSON.stringify({ v: 1, type: 'reject', reason }));
            ws.close(code);
        };
        ws.once('message', (data, isBinary) => {
            const parsed = isBinary ? undefined : parseEngineMessage(Buffer.from(toBytes(data)).toString('utf8'));
            if (parsed?.kind !== 'ok') {
                ws.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                return;
            }
            const auth = parsed.message;
            const entry = options.registry(auth.engineId);
            if (entry === undefined || !verifyTunnelAuth(entry.publicKey, challenge, auth)) {
                reject('auth-failed', TUNNEL_CLOSE_CODE.AUTH_FAILED);
                return;
            }
            const negotiated = negotiateTunnel(
                { versions: challenge.protocolVersions, features: challenge.features },
                { versions: auth.protocolVersions, features: auth.features },
            );
            if (negotiated.kind === 'unsupported-version') {
                reject('unsupported-version', TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                return;
            }
            const ready: TunnelReady = {
                v: 1,
                type: 'ready',
                protocolVersion: negotiated.protocolVersion,
                features: [...negotiated.features],
                hostnames: [...entry.hostnames],
            };
            ws.send(JSON.stringify(ready));
            startSession(ws, auth.engineId, ready);
        });
        ws.send(JSON.stringify(challenge));
    });

    server.listen(options.port ?? 0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    async function kill(): Promise<void> {
        for (const client of wss.clients) client.terminate();
        for (const socket of sockets) socket.destroy();
        wss.close();
        if (server.listening) {
            server.close();
            await once(server, 'close');
        }
    }

    return {
        port,
        url: `wss://${options.relayId}:${String(port)}${TUNNEL_PATH}`,
        connections: () => accepted,
        sessions: () => live.size,
        waitForSession() {
            const session = unclaimed.shift();
            if (session !== undefined) return Promise.resolve(session);
            return new Promise((resolve) => {
                waiters.push(resolve);
            });
        },
        kill,
        close: kill,
    };
}
