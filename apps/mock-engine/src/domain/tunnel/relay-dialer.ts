import type { Bytes } from '@ptbk/protocol';

import type { RelayTarget } from './relay-target';

/** Events of one open WebSocket to a relay. Attached before the socket opens, so no message can be missed. */
export interface RelayConnectionHandlers {
    onText(text: string): void;
    onBinary(bytes: Bytes): void;
    /** Fires once, for a close from either side or a lost connection (1006). Not fired for a dial that failed. */
    onClose(code: number): void;
}

export interface RelayConnection {
    sendText(text: string): void;
    sendBinary(bytes: Bytes): void;
    /** Starts the WebSocket close handshake; idempotent. `onClose` follows. */
    close(code: number): void;
}

/** Why an attempt failed before the WebSocket opened. Carries no message text, which could quote a credential. */
export type DialFailure =
    | { readonly reason: 'timeout' }
    | { readonly reason: 'aborted' }
    | { readonly reason: 'network' }
    /** The relay certificate did not verify (untrusted CA, wrong hostname, expired). */
    | { readonly reason: 'tls' }
    /** The proxy answered `CONNECT` with a non-2xx status (407 when its credentials are missing or wrong). */
    | { readonly reason: 'proxy-status'; readonly status: number }
    /** The relay answered the upgrade request with an HTTP status instead of 101. */
    | { readonly reason: 'upgrade-status'; readonly status: number }
    /** The relay accepted the upgrade without agreeing to `TUNNEL_SUBPROTOCOL`, or broke the WebSocket protocol. */
    | { readonly reason: 'protocol' };

export type DialResult =
    | { readonly kind: 'open'; readonly connection: RelayConnection }
    | { readonly kind: 'failed'; readonly failure: DialFailure };

/**
 * Opens an authenticated-transport WebSocket to one relay (TLS verified for `target.relayId`, through a proxy when one
 * applies). Never rejects: every expected failure is a `DialFailure`.
 */
export interface RelayDialer {
    dial(target: RelayTarget, handlers: RelayConnectionHandlers, signal: AbortSignal): Promise<DialResult>;
}
