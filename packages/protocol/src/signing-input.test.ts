import { describe, expect, it } from 'vitest';
import type { Bytes } from './bytes';
import type { SigningContext } from './signing-input';
import { SIGNING_CONTEXT, signingInput } from './signing-input';
import { fromHex, toHex } from './testing/hex';

describe('signingInput', () => {
    it('matches the golden vector with string and Bytes parts', () => {
        // Computed independently with Python: b'ptbk-sig\0' + bytes([len(ctx)]) + ctx + (struct.pack('>I', len(p)) + p)…
        expect(toHex(signingInput('ptbk-tunnel-v1', 'relay-fsn.example.net', fromHex('0001feff'), '', 'zá|\0'))).toBe(
            '7074626b2d736967000e7074626b2d74756e6e656c2d76310000001572656c61792d66736e2e6578616d706c652e6e6574000000040001feff00000000000000057ac3a17c00',
        );
    });

    it('encodes a context without parts', () => {
        expect(toHex(signingInput(SIGNING_CONTEXT.hostname))).toBe(
            '7074626b2d73696700107074626b2d686f73746e616d652d7631',
        );
    });

    it('is unambiguous where a separator-joined encoding is not', () => {
        const pairs: [readonly (string | Bytes)[], readonly (string | Bytes)[]][] = [
            [
                ['ab', 'c'],
                ['a', 'bc'],
            ],
            [['a|b'], ['a', 'b']],
            [['a\0b'], ['a', 'b']],
            [[''], []],
            [['', ''], ['']],
            [
                ['a', ''],
                ['', 'a'],
            ],
            [[fromHex('00000001')], ['', '']],
        ];
        for (const [left, right] of pairs) {
            expect(signingInput('ptbk-hostname-v1', ...left)).not.toEqual(signingInput('ptbk-hostname-v1', ...right));
        }
    });

    it('separates the contexts', () => {
        const inputs = Object.values(SIGNING_CONTEXT).map((context) => toHex(signingInput(context, 'x')));
        expect(new Set(inputs).size).toBe(Object.values(SIGNING_CONTEXT).length);
    });

    it('lists the protocol contexts', () => {
        expect(SIGNING_CONTEXT).toEqual({
            tunnel: 'ptbk-tunnel-v1',
            hostname: 'ptbk-hostname-v1',
            register: 'ptbk-register-v1',
            heartbeat: 'ptbk-heartbeat-v1',
            accessTicket: 'ptbk-access-ticket-v1',
            memberRevocation: 'ptbk-member-revocation-v1',
        });
        expect(Object.isFrozen(SIGNING_CONTEXT)).toBe(true);
    });

    it('never starts like a DSSE PAE', () => {
        const prefix = new TextDecoder().decode(signingInput('ptbk-register-v1').subarray(0, 7));
        expect(prefix).not.toBe('DSSEv1 ');
    });

    it.each(['ptbk-tunnel-v2', 'ptbk-release-v1', '', 'PTBK-TUNNEL-V1'])('throws on unknown context %j', (context) => {
        expect(() => signingInput(context as SigningContext, 'x')).toThrow(RangeError);
    });

    it('throws on a part whose length does not fit in u32', () => {
        const huge = { length: 2 ** 32 } as unknown as Bytes;
        expect(() => signingInput('ptbk-hostname-v1', huge)).toThrow(RangeError);
    });
});
