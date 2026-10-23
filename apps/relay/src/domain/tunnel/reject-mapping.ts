import type { TunnelCloseCode, TunnelReject, TunnelRejectReason } from '@ptbk/protocol';
import { TUNNEL_CLOSE_CODE } from '@ptbk/protocol';

import type { HandshakeRejectReason } from './handshake';

/** RFC 6455 "Try Again Later": the one reject outside 4000–4999, so generic clients and proxies retry later (C-02). */
export const TRY_AGAIN_LATER = 1013;

/** Why a handshake ends without `ready`: a verification outcome (a limit included) or the handshake timeout. */
export type HandshakeFailure = HandshakeRejectReason | 'timeout';

/** Every {@link HandshakeFailure}, for metric labels; the test checks the list is complete. */
export const HANDSHAKE_FAILURES = [
    'unknown-engine',
    'suspended',
    'bad-signature',
    'id-key-mismatch',
    'registry-unavailable',
    'unsupported-version',
    'malformed',
    'rate-limited',
    'timeout',
] as const satisfies readonly HandshakeFailure[];

export interface WireRejection {
    /** `null`: close without a `reject` message (malformed input). */
    readonly message: TunnelReject | null;
    readonly closeCode: TunnelCloseCode | typeof TRY_AGAIN_LATER;
}

function reject(reason: TunnelRejectReason, closeCode: WireRejection['closeCode']): WireRejection {
    return { message: { v: 1, type: 'reject', reason }, closeCode };
}

/**
 * The only place that decides what a refused engine learns: C-02's coarse reasons, so unknown engines, bad
 * signatures, ID/key mismatches and registry outages look the same on the wire.
 *
 * Decided 2026-10-20 (Seb): a timeout closes with `AUTH_FAILED`; malformed input closes with `PROTOCOL_ERROR` and no
 * `reject`.
 */
export function toWireRejection(failure: HandshakeFailure): WireRejection {
    switch (failure) {
        case 'unknown-engine':
        case 'bad-signature':
        case 'id-key-mismatch':
        case 'registry-unavailable':
            return reject('auth-failed', TUNNEL_CLOSE_CODE.AUTH_FAILED);
        case 'suspended':
            return reject('suspended', TUNNEL_CLOSE_CODE.SUSPENDED);
        case 'unsupported-version':
            return reject('unsupported-version', TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
        case 'timeout':
            return reject('timeout', TUNNEL_CLOSE_CODE.AUTH_FAILED);
        case 'rate-limited':
            return reject('rate-limited', TRY_AGAIN_LATER);
        case 'malformed':
            return { message: null, closeCode: TUNNEL_CLOSE_CODE.PROTOCOL_ERROR };
    }
}
