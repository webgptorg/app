import type { Duplex } from 'node:stream';
import type { SecureContext, TLSSocket } from 'node:tls';
import { createSecureContext, createServer } from 'node:tls';

import type { Hostname } from '@ptbk/protocol';
import { Hostname as HostnameSchema } from '@ptbk/protocol';

import type { Logger } from '../domain/logger';
import type { AcmeChallenges } from '../domain/tls/acme-challenges';
import { ACME_TLS_ALPN_PROTOCOL } from '../domain/tls/alpn-dispatch';
import { HANDSHAKE_TIMEOUT_MS } from './tls-stream-server';

export interface TlsAlpnResponderDeps {
    readonly challenges: AcmeChallenges;
    readonly logger: Logger;
    readonly handshakeTimeoutMs?: number;
}

export interface TlsAlpnResponder {
    /** Answers one validation connection for `hostname`, whose ClientHello the caller already peeked at. */
    handle(stream: Duplex, hostname: Hostname): void;
    /** Destroys every connection; later streams are destroyed on arrival. */
    close(): void;
}

class NoChallengeError extends Error {
    readonly code = 'ERR_NO_PENDING_CHALLENGE';
    constructor() {
        super('no challenge pending for this server name');
        this.name = 'NoChallengeError';
    }
}

/**
 * The TLS-ALPN-01 side of the engine (RFC 8737): a TLS server that speaks only `acme-tls/1` and presents the
 * self-signed challenge certificate carrying the `acmeIdentifier` extension. The CA only needs the handshake, so the
 * connection is closed right after it; no application data is ever read or written. The challenge is looked up again
 * at handshake time, so one that settled while the hello was in flight is not served.
 */
export function createTlsAlpnResponder(deps: TlsAlpnResponderDeps): TlsAlpnResponder {
    const { challenges, logger } = deps;
    const live = new Set<Duplex>();
    let closed = false;

    return {
        handle(stream, hostname) {
            stream.on('error', () => undefined);
            if (closed) {
                stream.destroy();
                return;
            }
            live.add(stream);
            stream.once('close', () => live.delete(stream));
            const server = createServer({
                minVersion: 'TLSv1.3',
                ALPNProtocols: [ACME_TLS_ALPN_PROTOCOL],
                handshakeTimeout: deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
                SNICallback(servername: string, callback: (error: Error | null, context?: SecureContext) => void) {
                    const parsed = HostnameSchema.safeParse(servername);
                    const credentials =
                        parsed.success && parsed.data === hostname ? challenges.lookup(hostname) : undefined;
                    if (credentials === undefined) {
                        callback(new NoChallengeError());
                        return;
                    }
                    callback(
                        null,
                        createSecureContext({
                            cert: credentials.certificateChainPem,
                            key: credentials.privateKeyPem.reveal(),
                            minVersion: 'TLSv1.3',
                        }),
                    );
                },
            });
            server.once('tlsClientError', (error: NodeJS.ErrnoException, failed: TLSSocket) => {
                logger.info('acme.challenge-handshake-failed', { hostname, code: error.code ?? error.name });
                failed.destroy();
                stream.destroy();
            });
            server.once('secureConnection', (socket: TLSSocket) => {
                logger.info('acme.challenge-served', { hostname });
                socket.once('close', () => stream.destroy());
                socket.end();
            });
            server.emit('connection', stream);
        },
        close() {
            closed = true;
            for (const stream of [...live]) stream.destroy();
        },
    };
}
