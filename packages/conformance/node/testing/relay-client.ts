import * as tls from 'node:tls';

import type { RelayId } from '@ptbk/protocol';
import { TUNNEL_SUBPROTOCOL } from '@ptbk/protocol';
import { WebSocket } from 'ws';

import type { FakeRelay } from '../fake-relay/fake-relay';

/** A bare WebSocket to the fake relay, for tests that play a broken engine by hand. */
export function dialRelay(
    relay: FakeRelay,
    relayId: RelayId,
    caPem: string,
    options: { readonly path?: string; readonly protocols?: readonly string[] } = {},
): Promise<WebSocket> {
    const url = new URL(relay.url(relayId));
    if (options.path !== undefined) url.pathname = options.path;
    const ws = new WebSocket(url, [...(options.protocols ?? [TUNNEL_SUBPROTOCOL])], {
        createConnection: () => tls.connect({ host: '127.0.0.1', port: relay.port, servername: relayId, ca: [caPem] }),
        perMessageDeflate: false,
    });
    return new Promise((resolve, reject) => {
        ws.once('open', () => {
            resolve(ws);
        });
        ws.once('error', reject);
    });
}

/** The next text message, parsed. */
export function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        ws.once('message', (data) => {
            resolve(JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>);
        });
    });
}

export function closeCode(ws: WebSocket): Promise<number> {
    return new Promise((resolve) => {
        ws.once('close', (code) => {
            resolve(code);
        });
    });
}
