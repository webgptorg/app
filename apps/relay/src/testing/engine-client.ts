import type { RelayId, RelayMessage, Signer, TunnelAuth, TunnelChallenge, TunnelFeature } from '@ptbk/protocol';
import {
    EngineVersion,
    TUNNEL_FEATURES,
    TUNNEL_PATH,
    TUNNEL_PROTOCOL_VERSIONS,
    TUNNEL_SUBPROTOCOL,
    parseRelayMessage,
    signTunnelAuth,
} from '@ptbk/protocol';
import type { ClientOptions } from 'ws';
import { WebSocket } from 'ws';

export const ENGINE_VERSION = EngineVersion.parse('1.8.2');

export interface ClientClose {
    readonly code: number;
}

/** A minimal engine built from `@ptbk/protocol`, for tests against the real listener. */
export interface TestEngineClient {
    readonly ws: WebSocket;
    /** Resolves when the WebSocket opens; rejects if it closes or fails first. */
    readonly opened: Promise<void>;
    /** The next text message from the relay, parsed strictly. */
    nextMessage(): Promise<RelayMessage>;
    readonly closed: Promise<ClientClose>;
    sendText(text: string): void;
    /** Signs `auth` for `challenge` with the C-02 helper, for a test to send as is or tampered. */
    signAuth(challenge: TunnelChallenge, offer?: EngineOffer): Promise<TunnelAuth>;
    /** Signs `auth` for `challenge` and sends it. */
    authenticate(challenge: TunnelChallenge, offer?: EngineOffer): Promise<void>;
}

export interface EngineOffer {
    readonly versions?: readonly number[];
    readonly features?: readonly TunnelFeature[];
}

export interface ConnectOptions {
    readonly port: number;
    readonly relayId: RelayId;
    readonly ca: string;
    readonly signer: Signer;
    readonly protocols?: readonly string[];
    readonly path?: string;
    /** `false` lets a test withhold pongs. */
    readonly autoPong?: boolean;
    /** Replaces the TLS connection `ws` would open, e.g. to control how its bytes reach the relay. */
    readonly createConnection?: ClientOptions['createConnection'];
}

export function connectEngine(options: ConnectOptions): TestEngineClient {
    const { port, relayId, ca, signer, protocols = [TUNNEL_SUBPROTOCOL], path = TUNNEL_PATH } = options;
    // `servername` reaches `tls.connect` (SNI and the certificate check) though `ws` does not declare it.
    const clientOptions: ClientOptions & { readonly servername: string } = {
        ca,
        servername: relayId,
        perMessageDeflate: false,
        autoPong: options.autoPong ?? true,
        ...(options.createConnection === undefined ? {} : { createConnection: options.createConnection }),
    };
    const ws = new WebSocket(`wss://127.0.0.1:${String(port)}${path}`, [...protocols], clientOptions);
    const queue: RelayMessage[] = [];
    const waiting: ((message: RelayMessage) => void)[] = [];
    ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const parsed = parseRelayMessage(data.toString('utf8'));
        if (parsed.kind === 'invalid') throw new Error('relay sent an invalid handshake message');
        const wake = waiting.shift();
        if (wake === undefined) queue.push(parsed.message);
        else wake(parsed.message);
    });
    ws.on('error', () => undefined);
    const closed = new Promise<ClientClose>((resolve) => {
        ws.once('close', (code: number) => {
            resolve({ code });
        });
    });
    const opened = new Promise<void>((resolve, reject) => {
        ws.once('open', () => {
            resolve();
        });
        ws.once('close', () => {
            reject(new Error('closed before open'));
        });
    });
    opened.catch(() => undefined);
    async function signAuth(challenge: TunnelChallenge, offer: EngineOffer = {}): Promise<TunnelAuth> {
        const signed = await signTunnelAuth(
            signer,
            challenge,
            {
                version: ENGINE_VERSION,
                protocolVersions: offer.versions ?? TUNNEL_PROTOCOL_VERSIONS,
                features: offer.features ?? TUNNEL_FEATURES,
            },
            { dialledRelayId: relayId },
        );
        if (signed.kind !== 'signed') throw new Error('challenge names another relay');
        return signed.auth;
    }
    return {
        ws,
        opened,
        closed,
        nextMessage() {
            const message = queue.shift();
            if (message !== undefined) return Promise.resolve(message);
            return new Promise((resolve) => waiting.push(resolve));
        },
        sendText(text) {
            ws.send(text);
        },
        signAuth,
        async authenticate(challenge, offer) {
            ws.send(JSON.stringify(await signAuth(challenge, offer)));
        },
    };
}
