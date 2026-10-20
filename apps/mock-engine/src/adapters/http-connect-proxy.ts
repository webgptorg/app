import * as net from 'node:net';

import type { DialFailure } from '../domain/tunnel/relay-dialer';
import type { NoProxyRule, ProxyConfig } from './proxy-config';

/** Bound on the proxy's response head, so a hostile or broken proxy cannot make us buffer without limit. */
export const MAX_PROXY_RESPONSE_HEAD_BYTES = 16_384;

const HEAD_END = '\r\n\r\n';
const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: |\r|$)/;

function matchesRule(rule: NoProxyRule, host: string, port: number): boolean {
    if (rule.port !== null && rule.port !== port) return false;
    return rule.host === '*' || host === rule.host || host.endsWith(`.${rule.host}`);
}

/** The proxy to use for `host:port`, or null when there is none or `NO_PROXY` exempts the host. */
export function proxyFor(proxy: ProxyConfig | null, host: string, port: number): ProxyConfig | null {
    if (proxy === null) return null;
    const target = host.toLowerCase();
    return proxy.noProxy.some((rule) => matchesRule(rule, target, port)) ? null : proxy;
}

export type ConnectTunnelResult =
    | { readonly kind: 'connected'; readonly socket: net.Socket }
    | { readonly kind: 'failed'; readonly failure: DialFailure };

export interface ConnectTunnelRequest {
    readonly proxy: ProxyConfig;
    readonly host: string;
    readonly port: number;
    readonly signal: AbortSignal;
}

function authority(host: string, port: number): string {
    return `${net.isIPv6(host) ? `[${host}]` : host}:${String(port)}`;
}

function connectRequest(proxy: ProxyConfig, host: string, port: number): string {
    const target = authority(host, port);
    const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
    if (proxy.credentials !== null) {
        const { username, password } = proxy.credentials;
        const token = Buffer.from(`${username}:${password.reveal()}`, 'utf8').toString('base64');
        lines.push(`Proxy-Authorization: Basic ${token}`);
    }
    return `${lines.join('\r\n')}${HEAD_END}`;
}

/**
 * Opens a TCP connection to `host:port` through an HTTP proxy with `CONNECT`. The relay's TLS runs over the returned
 * socket, so the proxy sees only ciphertext. Failures carry the proxy's status code at most: never its URL, its
 * credentials or anything it wrote.
 */
export function openConnectTunnel({ proxy, host, port, signal }: ConnectTunnelRequest): Promise<ConnectTunnelResult> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve({ kind: 'failed', failure: { reason: 'aborted' } });
            return;
        }
        const socket = net.connect({ host: proxy.host, port: proxy.port });
        let head = Buffer.alloc(0);

        const finish = (result: ConnectTunnelResult): void => {
            signal.removeEventListener('abort', onAbort);
            socket.off('data', onData);
            socket.off('error', onError);
            socket.off('close', onClose);
            if (result.kind === 'failed') socket.destroy();
            resolve(result);
        };
        const fail = (failure: DialFailure): void => {
            finish({ kind: 'failed', failure });
        };
        const onAbort = (): void => {
            fail({ reason: 'aborted' });
        };
        const onError = (): void => {
            fail({ reason: 'network' });
        };
        const onClose = (): void => {
            fail({ reason: 'network' });
        };
        const onData = (chunk: Buffer): void => {
            head = Buffer.concat([head, chunk]);
            const end = head.indexOf(HEAD_END);
            if (end === -1) {
                if (head.length > MAX_PROXY_RESPONSE_HEAD_BYTES) fail({ reason: 'network' });
                return;
            }
            if (end > MAX_PROXY_RESPONSE_HEAD_BYTES) {
                fail({ reason: 'network' });
                return;
            }
            const status = STATUS_LINE.exec(head.subarray(0, end).toString('latin1'));
            if (status === null) {
                fail({ reason: 'network' });
                return;
            }
            const code = Number(status[1]);
            if (code < 200 || code > 299) {
                fail({ reason: 'proxy-status', status: code });
                return;
            }
            socket.pause();
            const rest = head.subarray(end + HEAD_END.length);
            if (rest.length > 0) socket.unshift(rest);
            finish({ kind: 'connected', socket });
        };

        signal.addEventListener('abort', onAbort, { once: true });
        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
        socket.once('connect', () => {
            socket.write(connectRequest(proxy, host, port));
        });
    });
}
