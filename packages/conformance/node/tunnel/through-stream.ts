import type { X509Certificate } from 'node:crypto';
import * as tls from 'node:tls';

import { ENGINE_API_PREFIX, EngineInfo, ProblemDetails } from '@ptbk/engine-api';
import { defaultHostname } from '@ptbk/protocol';
import type { Hostname } from '@ptbk/protocol';

import type { SessionCredential } from '../../src/target';
import type { OpenStreamOptions, RelayStream, RelayTunnel } from '../fake-relay/relay-tunnel';
import { ResponseReader, requestBytes } from './http1';
import type { HttpResponse } from './http1';

export interface EngineTlsOptions {
    /** SNI; null sends none. */
    readonly servername: string | null;
    /** The engine's trust anchor when known; otherwise the chain is not checked, only the name and dates. */
    readonly certificateAuthorityPem: string | null;
    readonly timeoutMs: number;
    readonly stream?: OpenStreamOptions;
}

export type EngineTls =
    | {
          readonly kind: 'ok';
          readonly stream: RelayStream;
          readonly socket: tls.TLSSocket;
          readonly protocol: string | null;
          readonly certificate: X509Certificate | null;
      }
    | { readonly kind: 'failed'; readonly stream: RelayStream; readonly reason: string };

/**
 * A TLS client over a new stream of `tunnel`: what a browser does through the relay. The engine must end TLS itself,
 * with TLS 1.3 and a certificate valid for the SNI it was asked for.
 */
export function connectThroughTunnel(tunnel: RelayTunnel, options: EngineTlsOptions): Promise<EngineTls> {
    const stream = tunnel.openStream(options.stream);
    const verify = options.certificateAuthorityPem !== null;
    const socket = tls.connect({
        socket: stream,
        // An empty servername sends no SNI at all.
        servername: options.servername ?? '',
        ALPNProtocols: ['http/1.1'],
        minVersion: 'TLSv1.2',
        rejectUnauthorized: verify,
        ...(verify ? { ca: [options.certificateAuthorityPem] } : {}),
        // Names are checked below for both cases, so the failure says which rule broke.
        checkServerIdentity: () => undefined,
    });
    return new Promise((resolve) => {
        const finish = (result: EngineTls): void => {
            clearTimeout(timer);
            socket.off('secureConnect', onSecure);
            socket.off('error', onError);
            socket.off('close', onClose);
            if (result.kind === 'failed') {
                socket.on('error', () => undefined);
                socket.destroy();
            }
            resolve(result);
        };
        const onSecure = (): void => {
            const raw = socket.getPeerX509Certificate();
            finish({
                kind: 'ok',
                stream,
                socket,
                protocol: socket.getProtocol(),
                certificate: raw ?? null,
            });
        };
        const onError = (error: Error & { code?: string }): void => {
            finish({ kind: 'failed', stream, reason: `TLS handshake failed (${error.code ?? error.name})` });
        };
        const onClose = (): void => {
            finish({ kind: 'failed', stream, reason: 'the stream closed during the TLS handshake' });
        };
        const timer = setTimeout(() => {
            finish({ kind: 'failed', stream, reason: `no TLS handshake within ${String(options.timeoutMs)} ms` });
        }, options.timeoutMs);
        socket.once('secureConnect', onSecure);
        socket.once('error', onError);
        socket.once('close', onClose);
    });
}

/** Why the certificate does not fit `hostname`, or null when it does (name, validity period, server use). */
export function certificateProblem(certificate: X509Certificate | null, hostname: string): string | null {
    if (certificate === null) return 'the engine presented no certificate';
    if (certificate.checkHost(hostname) === undefined) return `the certificate is not valid for ${hostname}`;
    const now = Date.now();
    if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) < now) {
        return 'the certificate is outside its validity period';
    }
    return null;
}

export function engineHostname(tunnel: RelayTunnel, engineDomain: Hostname): Hostname {
    return defaultHostname(tunnel.auth.engineId, engineDomain);
}

export function credentialHeaders(credential: SessionCredential | null): Record<string, string> {
    if (credential === null) return {};
    return 'cookie' in credential ? { Cookie: credential.cookie } : { Authorization: `Bearer ${credential.bearer}` };
}

/** One `GET /api/v1/engine` on an established TLS connection. */
export async function getEngine(
    socket: tls.TLSSocket,
    hostname: string,
    credential: SessionCredential | null,
    timeoutMs: number,
): Promise<{ kind: 'ok'; response: HttpResponse } | { kind: 'failed'; reason: string }> {
    socket.write(
        requestBytes({ host: hostname, path: `${ENGINE_API_PREFIX}/engine`, headers: credentialHeaders(credential) }),
    );
    const read = await new ResponseReader(socket).next(timeoutMs);
    return read.kind === 'ok' ? read : { kind: 'failed', reason: read.reason };
}

/**
 * Judges `GET /engine`'s answer: with a session it must name the engine the relay authenticated; without one it must
 * be the contract's 401 problem. Either way it proves the request reached that engine's API through the stream.
 */
export function engineAnswerProblem(response: HttpResponse, engineId: string, authenticated: boolean): string | null {
    const type = response.headers.get('content-type') ?? '';
    let json: unknown;
    try {
        json = JSON.parse(response.body.toString('utf8'));
    } catch {
        return `GET /engine answered ${String(response.status)} without a JSON body`;
    }
    if (authenticated) {
        if (response.status !== 200) return `GET /engine with a session answered ${String(response.status)}`;
        const info = EngineInfo.safeParse(json);
        if (!info.success) return 'GET /engine answered a body that does not parse as EngineInfo';
        return info.data.engineId === engineId ? null : 'GET /engine names another engineId than the one in auth';
    }
    if (response.status !== 401 || !type.startsWith('application/problem+json')) {
        return `GET /engine without a session answered ${String(response.status)} ${type}, not 401 problem+json`;
    }
    return ProblemDetails.safeParse(json).success ? null : 'the 401 body is not a strict problem';
}
