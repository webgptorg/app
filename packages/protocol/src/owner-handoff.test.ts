import { describe, expect, it } from 'vitest';

import {
    OWNER_HANDOFF_LIFETIME_MS,
    OwnerSetupCommitment,
    OwnerSetupSecret,
    newOwnerSetupSecret,
    ownerSetupCommitment,
    ownerSetupCommitmentDigest,
} from './owner-handoff';
import { createCryptoRandom } from './random';
import { toHex } from './testing/hex';

// Computed independently: Python's hashlib over the 22 ASCII characters, then base64url without padding.
const VECTOR = {
    secret: 'AAECAwQFBgcICQoLDA0ODw',
    commitment: 'XSYR1aTdK0Cyd9_bXs9bSYGRUNfVxi9O75YMsMJNsgw',
    sha256Hex: '5d2611d5a4dd2b40b277dfdb5ecf5b49819150d7d5c62f4eef960cb0c24db20c',
};

describe('owner setup handoff', () => {
    it('commits to the text of the secret, as engines hash their own setup secret', async () => {
        const commitment = await ownerSetupCommitment(OwnerSetupSecret.parse(VECTOR.secret));
        expect(commitment).toBe(VECTOR.commitment);
        expect(toHex(ownerSetupCommitmentDigest(commitment))).toBe(VECTOR.sha256Hex);
    });

    it('draws 22 base64url characters from the crypto random', () => {
        const random = createCryptoRandom();
        const secrets = new Set(Array.from({ length: 32 }, () => newOwnerSetupSecret(random)));
        expect(secrets.size).toBe(32);
        for (const secret of secrets) expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });

    it.each([
        ['21 characters', VECTOR.secret.slice(1)],
        ['23 characters', `${VECTOR.secret}A`],
        ['non-canonical trailing bits', `${VECTOR.secret.slice(0, -1)}x`],
        ['standard base64', `${VECTOR.secret.slice(0, -1)}+`],
    ])('refuses a secret of %s', (_, value) => {
        expect(OwnerSetupSecret.safeParse(value).success).toBe(false);
    });

    it.each([
        ['42 characters', VECTOR.commitment.slice(1)],
        ['padding', `${VECTOR.commitment}=`],
        ['non-canonical trailing bits', `${VECTOR.commitment.slice(0, -1)}x`],
    ])('refuses a commitment with %s', (_, value) => {
        expect(OwnerSetupCommitment.safeParse(value).success).toBe(false);
    });

    it('refuses to decode a commitment that skipped the schema', () => {
        expect(() => ownerSetupCommitmentDigest('!'.repeat(43) as OwnerSetupCommitment)).toThrow(TypeError);
    });

    it('lives 30 minutes, as the engine’s own setup link', () => {
        expect(OWNER_HANDOFF_LIFETIME_MS).toBe(30 * 60_000);
    });
});
