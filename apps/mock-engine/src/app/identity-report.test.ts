import { Hostname, createWebCryptoSigner, encodeBase64Url, generateEd25519KeyPair } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { engineIdentityFromSigner } from '../domain/identity/engine-identity';
import { identityReport } from './identity-report';

describe('identityReport', () => {
    it('reports the engine ID, base64url public key and default hostname', async () => {
        const identity = await engineIdentityFromSigner(
            await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false })),
        );
        const report = identityReport(identity, Hostname.parse('engines.example.test'));
        expect(report).toEqual({
            engineId: identity.engineId,
            enginePublicKey: encodeBase64Url(identity.publicKey),
            hostname: `${identity.engineId}.engines.example.test`,
        });
        expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    });
});
