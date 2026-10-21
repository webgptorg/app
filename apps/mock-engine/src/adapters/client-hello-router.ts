import type { Duplex } from 'node:stream';

import type { Hostname } from '@ptbk/protocol';
import { createClientHelloBuffer } from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import type { Logger } from '../domain/logger';
import type { AcmeChallenges } from '../domain/tls/acme-challenges';
import type { CompleteClientHello } from '../domain/tls/alpn-dispatch';
import { dispatchClientHello } from '../domain/tls/alpn-dispatch';
import type { RemoteAddress } from '../domain/tunnel/tunnel-stream';
import type { TlsAlpnResponder } from './tls-alpn-responder';
import { HANDSHAKE_TIMEOUT_MS } from './tls-stream-server';

/** The relay's own limit (R-04): a hello it would not route is not one the engine waits for either. */
export const CLIENT_HELLO_MAX_BYTES = 16_384;

export type PeekOutcome = CompleteClientHello | { readonly kind: 'timeout' } | { readonly kind: 'ended' };

/**
 * Reads a stream until its ClientHello parses (or cannot), then puts every byte read back with `unshift`, so whoever
 * takes the stream next sees it untouched. `done` runs once; after `timeout` or `ended` the stream is the caller's to
 * destroy.
 */
export function peekClientHello(
    stream: Duplex,
    options: { readonly clock: Clock; readonly timeoutMs: number },
    done: (outcome: PeekOutcome) => void,
): void {
    const buffer = createClientHelloBuffer({ maxBytes: CLIENT_HELLO_MAX_BYTES });
    let finished = false;
    const finish = (outcome: PeekOutcome): void => {
        if (finished) return;
        finished = true;
        cancelTimer();
        stream.off('readable', onReadable);
        stream.off('end', onEnded);
        stream.off('close', onEnded);
        done(outcome);
    };
    const onEnded = (): void => {
        finish({ kind: 'ended' });
    };
    const onReadable = (): void => {
        // Not in object mode and no encoding set: every chunk is a Buffer.
        for (let chunk = stream.read() as Buffer | null; chunk !== null; chunk = stream.read() as Buffer | null) {
            const parse = buffer.push(chunk);
            if (parse.kind !== 'need-more') {
                stream.unshift(Buffer.from(buffer.bytes()));
                finish(parse);
                return;
            }
        }
    };
    const cancelTimer = options.clock.setTimeout(() => {
        finish({ kind: 'timeout' });
    }, options.timeoutMs);
    stream.on('readable', onReadable);
    stream.once('end', onEnded);
    stream.once('close', onEnded);
}

export interface ClientHelloRouterDeps {
    readonly challenges: AcmeChallenges;
    readonly responder: TlsAlpnResponder;
    /** The engine's own TLS server: everything that is not a TLS-ALPN-01 validation. */
    readonly normal: (stream: Duplex, remote: RemoteAddress) => void;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly timeoutMs?: number;
}

export interface ClientHelloRouter {
    handle(stream: Duplex, remote: RemoteAddress): void;
    /** Destroys streams still being peeked at; later streams are destroyed on arrival. */
    close(): void;
}

/**
 * Sits in front of every TLS server inside the tunnel. The relay routes an ACME validation connection exactly like a
 * browser (it never looks at ALPN), so telling the two apart is the engine's job, from the ClientHello.
 */
export function createClientHelloRouter(deps: ClientHelloRouterDeps): ClientHelloRouter {
    const { challenges, responder, logger } = deps;
    const peeking = new Set<Duplex>();
    let closed = false;
    const hasPendingChallenge = (hostname: Hostname): boolean => challenges.lookup(hostname) !== undefined;

    return {
        handle(stream, remote) {
            stream.on('error', () => undefined);
            if (closed) {
                stream.destroy();
                return;
            }
            peeking.add(stream);
            peekClientHello(
                stream,
                { clock: deps.clock, timeoutMs: deps.timeoutMs ?? HANDSHAKE_TIMEOUT_MS },
                (hello) => {
                    peeking.delete(stream);
                    if (hello.kind === 'timeout' || hello.kind === 'ended') {
                        logger.info('tls.hello-incomplete', { outcome: hello.kind });
                        stream.destroy();
                        return;
                    }
                    const decision = dispatchClientHello(hello, hasPendingChallenge);
                    switch (decision.kind) {
                        case 'normal':
                            deps.normal(stream, remote);
                            return;
                        case 'acme-challenge':
                            responder.handle(stream, decision.hostname);
                            return;
                        case 'reject':
                            logger.info('tls.hello-rejected', { reason: decision.reason });
                            stream.destroy();
                            return;
                    }
                },
            );
        },
        close() {
            closed = true;
            for (const stream of [...peeking]) stream.destroy();
            peeking.clear();
        },
    };
}
