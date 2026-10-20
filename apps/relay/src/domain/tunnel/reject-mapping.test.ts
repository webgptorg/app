import { TUNNEL_CLOSE_CODE, TunnelReject } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { HandshakeFailure, WireRejection } from './reject-mapping';
import { TRY_AGAIN_LATER, toWireRejection } from './reject-mapping';

const reject = (reason: string): unknown => ({ v: 1, type: 'reject', reason });

describe('toWireRejection', () => {
    it.each<[HandshakeFailure, unknown, number]>([
        ['unknown-engine', reject('auth-failed'), TUNNEL_CLOSE_CODE.AUTH_FAILED],
        ['bad-signature', reject('auth-failed'), TUNNEL_CLOSE_CODE.AUTH_FAILED],
        ['id-key-mismatch', reject('auth-failed'), TUNNEL_CLOSE_CODE.AUTH_FAILED],
        ['registry-unavailable', reject('auth-failed'), TUNNEL_CLOSE_CODE.AUTH_FAILED],
        ['suspended', reject('suspended'), TUNNEL_CLOSE_CODE.SUSPENDED],
        ['unsupported-version', reject('unsupported-version'), TUNNEL_CLOSE_CODE.PROTOCOL_ERROR],
        ['timeout', reject('timeout'), TUNNEL_CLOSE_CODE.AUTH_FAILED],
        ['rate-limited', reject('rate-limited'), 1013],
        ['malformed', null, TUNNEL_CLOSE_CODE.PROTOCOL_ERROR],
    ])('maps %s to its C-02 reason and close code', (failure, message, closeCode) => {
        expect(toWireRejection(failure)).toEqual({ message, closeCode });
    });

    it('sends only messages that pass the TunnelReject schema', () => {
        const failures: HandshakeFailure[] = ['suspended', 'unsupported-version', 'timeout', 'rate-limited'];
        for (const failure of failures) {
            const { message } = toWireRejection(failure);
            expect(TunnelReject.parse(message)).toEqual(message);
        }
    });

    it('makes unknown engines, bad signatures, ID/key mismatches and registry outages indistinguishable', () => {
        const wire = (['unknown-engine', 'bad-signature', 'id-key-mismatch', 'registry-unavailable'] as const).map(
            (failure): WireRejection => toWireRejection(failure),
        );
        for (const other of wire) expect(JSON.stringify(other)).toBe(JSON.stringify(wire[0]));
    });

    it('closes rate-limited rejects with Try Again Later, the only code outside 4000-4999', () => {
        expect(TRY_AGAIN_LATER).toBe(1013);
        const all: HandshakeFailure[] = [
            'unknown-engine',
            'suspended',
            'bad-signature',
            'id-key-mismatch',
            'registry-unavailable',
            'unsupported-version',
            'malformed',
            'timeout',
        ];
        for (const failure of all) {
            const { closeCode } = toWireRejection(failure);
            expect(closeCode >= 4000 && closeCode <= 4999).toBe(true);
        }
    });
});
