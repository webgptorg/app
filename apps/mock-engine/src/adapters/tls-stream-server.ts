import type { Duplex } from 'node:stream';
import type { SecureContext, TLSSocket } from 'node:tls';
import { createSecureContext, createServer } from 'node:tls';

import type { Hostname } from '@ptbk/protocol';
import { Hostname as HostnameSchema } from '@ptbk/protocol';

import type { Logger } from '../domain/logger';
import type { CertificateSource, TlsCredentials } from '../domain/tls/certificate-source';
import type { RemoteAddress } from '../domain/tunnel/tunnel-stream';

/** Engine TLS is TLS 1.3 only (ADR 0014). */
const MIN_TLS_VERSION = 'TLSv1.3';
const ALPN_PROTOCOLS = ['http/1.1'];
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** What the HTTP layer may know about a connection. */
export interface SecureConnection {
    /** The SNI the certificate was chosen for. */
    readonly hostname: Hostname;
    /** The browser's address from the tunnel's `OPEN` frame. */
    readonly clientIp: string;
    readonly alpn: string | null;
    readonly tlsVersion: string;
}

export interface TlsStreamServerDeps {
    readonly certificates: CertificateSource;
    readonly logger: Logger;
    /** Receives each connection after a successful handshake; it owns the socket from then on. */
    readonly onSecureConnection: (socket: TLSSocket, connection: SecureConnection) => void;
    readonly handshakeTimeoutMs?: number;
}

export interface TlsStreamServer {
    /** Terminates TLS on one tunnel stream (or any duplex standing in for one). */
    handle(stream: Duplex, remote: RemoteAddress): void;
    /** Connections not yet closed, handshaking or established. */
    connections(): number;
    /** Destroys every connection; later streams are destroyed on arrival. */
    close(): void;
}

class UnknownServerNameError extends Error {
    readonly code = 'ERR_UNKNOWN_SERVER_NAME';
    constructor() {
        super('no certificate for this server name');
        this.name = 'UnknownServerNameError';
    }
}

/**
 * Browser TLS ends here, with a key only the engine holds; the relay only ever sees ciphertext. The certificate is
 * looked up per handshake by SNI, so a renewal applies to the next connection. No SNI, or one the source holds no
 * certificate for, fails the handshake: there is no default certificate.
 *
 * Each stream gets its own `tls.Server`, which never listens and costs a fraction of a millisecond: a `TLSSocket`
 * over a JS stream has no peer address and no public link back to that stream, so a shared server could not tell
 * the HTTP layer which `OPEN` frame (client IP) a connection came from. All of them share the SNI contexts.
 */
export function createTlsStreamServer(deps: TlsStreamServerDeps): TlsStreamServer {
    const { certificates, logger } = deps;
    const contexts = new WeakMap<TlsCredentials, SecureContext>();
    const live = new Set<Duplex>();
    let closed = false;

    function contextFor(credentials: TlsCredentials): SecureContext {
        let context = contexts.get(credentials);
        if (context === undefined) {
            context = createSecureContext({
                cert: credentials.certificateChainPem,
                key: credentials.privateKeyPem.reveal(),
                minVersion: MIN_TLS_VERSION,
            });
            contexts.set(credentials, context);
        }
        return context;
    }

    const options = {
        minVersion: MIN_TLS_VERSION,
        ALPNProtocols: ALPN_PROTOCOLS,
        handshakeTimeout: deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
        SNICallback(servername: string, callback: (error: Error | null, context?: SecureContext) => void): void {
            const hostname = HostnameSchema.safeParse(servername);
            const credentials = hostname.success ? certificates.current(hostname.data) : undefined;
            if (credentials === undefined) callback(new UnknownServerNameError());
            else callback(null, contextFor(credentials));
        },
    } as const;

    return {
        handle(stream, remote) {
            stream.on('error', () => undefined);
            if (closed) {
                stream.destroy();
                return;
            }
            live.add(stream);
            let socket: TLSSocket | undefined;
            stream.once('close', () => {
                live.delete(stream);
                socket?.destroy();
            });
            const server = createServer(options);
            server.once('tlsClientError', (error: NodeJS.ErrnoException, failed: TLSSocket) => {
                logger.info('tls.handshake-failed', { code: error.code ?? error.name });
                failed.destroy();
                stream.destroy();
            });
            server.once('secureConnection', (secured: TLSSocket) => {
                socket = secured;
                secured.once('close', () => stream.destroy());
                // The SNI callback already parsed it; a connection without one never gets this far.
                const hostname = HostnameSchema.safeParse(secured.servername);
                if (!hostname.success) {
                    secured.destroy();
                    return;
                }
                deps.onSecureConnection(secured, {
                    hostname: hostname.data,
                    clientIp: remote.address,
                    alpn: typeof secured.alpnProtocol === 'string' ? secured.alpnProtocol : null,
                    tlsVersion: secured.getProtocol() ?? 'unknown',
                });
            });
            server.emit('connection', stream);
        },
        // A destroyed stream emits 'close' a tick later; it no longer counts.
        connections: () => [...live].filter((stream) => !stream.destroyed).length,
        close() {
            closed = true;
            for (const stream of [...live]) stream.destroy();
        },
    };
}
