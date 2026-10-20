import { describe, expect, it } from 'vitest';
import { createWebCryptoSigner, generateEd25519KeyPair, verifyEd25519 } from './ed25519';
import { deriveEngineId } from './engine-id';
import { signHostnameClaim, verifyHostnameClaim } from './hostname-claim';
import { Hostname } from './ids';
import { signingInput } from './signing-input';

async function setup() {
    const signer = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
    const engineId = await deriveEngineId(signer.publicKey());
    return { signer, engineId, publicKey: signer.publicKey() };
}

describe('hostname claims', () => {
    const hostname = Hostname.parse('agents.customer.com');

    it('verifies a claim it signed', async () => {
        const { signer, engineId, publicKey } = await setup();
        const signature = await signHostnameClaim(signer, hostname, engineId);
        expect(verifyHostnameClaim(publicKey, hostname, engineId, signature)).toBe(true);
        expect(verifyEd25519(publicKey, signingInput('ptbk-hostname-v1', hostname, engineId), signature)).toBe(true);
    });

    it('fails for another hostname', async () => {
        const { signer, engineId, publicKey } = await setup();
        const signature = await signHostnameClaim(signer, hostname, engineId);
        expect(verifyHostnameClaim(publicKey, Hostname.parse('agents.attacker.com'), engineId, signature)).toBe(false);
    });

    it('fails for another engine ID', async () => {
        const { signer, engineId, publicKey } = await setup();
        const other = await setup();
        const signature = await signHostnameClaim(signer, hostname, engineId);
        expect(verifyHostnameClaim(publicKey, hostname, other.engineId, signature)).toBe(false);
    });

    it('fails for another key', async () => {
        const { signer, engineId } = await setup();
        const other = await setup();
        const signature = await signHostnameClaim(signer, hostname, engineId);
        expect(verifyHostnameClaim(other.publicKey, hostname, engineId, signature)).toBe(false);
    });

    it('fails for the same parts signed under the tunnel context', async () => {
        const { signer, engineId, publicKey } = await setup();
        const signature = await signer.sign(signingInput('ptbk-tunnel-v1', hostname, engineId));
        expect(verifyHostnameClaim(publicKey, hostname, engineId, signature)).toBe(false);
    });

    it('fails for a truncated signature', async () => {
        const { signer, engineId, publicKey } = await setup();
        const signature = await signHostnameClaim(signer, hostname, engineId);
        expect(verifyHostnameClaim(publicKey, hostname, engineId, signature.slice(0, 63))).toBe(false);
    });

    it('passes the abort signal to the signer', async () => {
        const { signer, engineId } = await setup();
        await expect(signHostnameClaim(signer, hostname, engineId, AbortSignal.abort())).rejects.toThrow();
    });
});
