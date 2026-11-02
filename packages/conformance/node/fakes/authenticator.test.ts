import { decodeBase64Url } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createPasskey } from './authenticator';

const ORIGIN = 'https://engine.localhost';

describe('createPasskey', () => {
    it.each([null, 'nope', {}, { challenge: 1, rp: {} }, { challenge: 'c' }, { challenge: 'c', rp: null }])(
        'refuses the unusable options %j',
        async (options) => {
            await expect(createPasskey(options, ORIGIN)).rejects.toThrow('no usable registration options');
        },
    );

    it('answers the challenge for the origin, as a browser would', async () => {
        const credential = (await createPasskey({ challenge: 'Y2hhbGxlbmdl', rp: {} }, ORIGIN)) as {
            id: string;
            response: { clientDataJSON: string };
        };
        const decoded = decodeBase64Url(credential.response.clientDataJSON);
        if (decoded.kind !== 'ok') throw new Error('clientDataJSON is not base64url');
        const clientData: unknown = JSON.parse(new TextDecoder().decode(decoded.bytes));
        expect(clientData).toEqual({
            type: 'webauthn.create',
            challenge: 'Y2hhbGxlbmdl',
            origin: ORIGIN,
            crossOrigin: false,
        });
    });

    it('gives every passkey its own credential', async () => {
        const options = { challenge: 'c', rp: { id: 'engine.localhost' } };
        const [one, two] = (await Promise.all([createPasskey(options, ORIGIN), createPasskey(options, ORIGIN)])) as {
            id: string;
        }[];
        expect(one?.id).not.toBe(two?.id);
    });
});
