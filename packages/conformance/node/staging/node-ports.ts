import { lookup } from 'node:dns/promises';
import type { PeerCertificate } from 'node:tls';
import { checkServerIdentity, connect, rootCertificates } from 'node:tls';

import type { CertificateName, DnsAnswer, StagingPorts, TlsProbe } from './types';

/** The system resolver, as a browser on this machine would resolve the name (hosts file and all). */
export async function lookupAddresses(hostname: string, signal: AbortSignal): Promise<DnsAnswer> {
    try {
        const answers = await abortable(lookup(hostname, { all: true, order: 'verbatim' }), signal);
        return { kind: 'resolved', addresses: answers.map(({ address }) => address) };
    } catch (error) {
        return { kind: 'failed', code: errorCode(error) };
    }
}

export interface TlsProbeOptions {
    /** Node's bundled public roots by default, so neither `NODE_EXTRA_CA_CERTS` nor a system store can widen them. */
    readonly ca?: readonly string[];
    readonly port?: number;
    /** Where to connect instead of the hostname itself; the SNI and the identity check still use the hostname. */
    readonly connectTo?: string;
}

/**
 * A handshake that verifies but does not refuse, so a development CA's certificate is reported by issuer instead of
 * hidden behind a bare error. Read-only: the socket closes right after the handshake.
 */
export function createTlsProbe(
    options: TlsProbeOptions = {},
): (hostname: string, signal: AbortSignal) => Promise<TlsProbe> {
    return (hostname, signal) =>
        new Promise((resolve) => {
            const socket = connect({
                host: options.connectTo ?? hostname,
                port: options.port ?? 443,
                servername: hostname,
                ca: [...(options.ca ?? rootCertificates)],
                rejectUnauthorized: false,
                ALPNProtocols: ['h2', 'http/1.1'],
            });
            const finish = (probe: TlsProbe): void => {
                signal.removeEventListener('abort', onAbort);
                socket.destroy();
                resolve(probe);
            };
            const onAbort = (): void => {
                finish({ kind: 'failed', code: 'TIMEOUT' });
            };
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            socket.once('error', (error) => {
                finish({ kind: 'failed', code: errorCode(error) });
            });
            socket.once('secureConnect', () => {
                const certificate = socket.getPeerCertificate(false);
                finish({
                    kind: 'handshake',
                    authorized: socket.authorized,
                    authorizationError: socket.authorized ? null : errorCode(socket.authorizationError),
                    hostnameMatches: checkServerIdentity(hostname, certificate) === undefined,
                    issuer: nameOf(certificate),
                    validToMs: Date.parse(certificate.valid_to),
                });
            });
        });
}

export function createNodeStagingPorts(fetchFn: typeof fetch): StagingPorts {
    return { lookup: lookupAddresses, probeTls: createTlsProbe(), fetch: fetchFn, nowMs: () => Date.now() };
}

function nameOf(certificate: PeerCertificate): CertificateName {
    // Node gives a multi-valued attribute as an array.
    const issuer = certificate.issuer as Partial<Record<'O' | 'CN', string | string[]>>;
    return { organization: first(issuer.O), commonName: first(issuer.CN) };
}

function first(value: string | string[] | undefined): string | null {
    if (value === undefined) return null;
    return (Array.isArray(value) ? value[0] : value) ?? null;
}

/** A socket error's code; `authorizationError` is already the code string at runtime, whatever its type says. */
function errorCode(error: unknown): string {
    if (typeof error === 'string') return error;
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : error instanceof Error ? error.message : 'unknown error';
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const onAbort = (): void => {
            reject(Object.assign(new Error('timed out'), { code: 'TIMEOUT' }));
        };
        if (signal.aborted) onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
        });
    });
}
