import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { describe, it } from 'vitest';

import { generateStagingSecrets, metricsToken, releaseKeyFromSeed } from './secrets.ts';

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const RELAY = 'relay-fsn.staging.example';

function secret(name: string): string {
    const found = generateStagingSecrets([RELAY]).secrets.find((s) => s.name === name);
    assert.ok(found, `${name} is generated`);
    return found.value;
}

describe('generateStagingSecrets', () => {
    it('makes the dashboard keys as config.ts parses them: 32 bytes, base64url without padding', () => {
        for (const name of ['RATE_LIMIT_HMAC_KEY', 'MEMBER_KEY']) {
            const value = secret(name);
            assert.match(value, BASE64URL_32_BYTES);
            assert.equal(Buffer.from(value, 'base64url').length, 32);
        }
    });

    it('makes a state passphrase of at least 32 characters', () => {
        assert.ok(secret('TF_VAR_state_passphrase').length >= 32);
    });

    it('makes one metrics token per relay and the matching RELAY_METRICS_TOKENS object', () => {
        const relays = [RELAY, 'relay-hel.staging.example'];
        const { secrets } = generateStagingSecrets(relays);
        const tokens = relays.map((relay) => secrets.find((s) => s.name === `metrics-token (${relay})`)?.value);
        for (const token of tokens) assert.match(token ?? '', /^ptbk_mt_[A-Za-z0-9_-]{43}$/);
        const json = secrets.find((s) => s.name === 'RELAY_METRICS_TOKENS')?.value ?? '';
        assert.deepEqual(JSON.parse(json), { [RELAY]: tokens[0], 'relay-hel.staging.example': tokens[1] });
    });

    it('makes a fresh value every run', () => {
        assert.notEqual(secret('RATE_LIMIT_HMAC_KEY'), secret('RATE_LIMIT_HMAC_KEY'));
        assert.notEqual(metricsToken(), metricsToken());
    });

    it('refuses to run without a relay', () => {
        assert.throws(() => generateStagingSecrets([]), RangeError);
    });

    it('says where every secret goes', () => {
        for (const s of generateStagingSecrets([RELAY]).secrets) assert.ok(s.goesTo.length > 0, s.name);
    });
});

describe('the UI staging release key', () => {
    it('is a 32-byte seed whose public key and keyid have the trust policy format', () => {
        const { secrets, releaseKeyPublic } = generateStagingSecrets([RELAY]);
        const seed = secrets.find((s) => s.name === 'UI_STAGING_RELEASE_KEY')?.value ?? '';
        assert.match(seed, BASE64URL_32_BYTES);
        assert.match(releaseKeyPublic.publicKey, BASE64URL_32_BYTES);
        assert.match(releaseKeyPublic.keyid, BASE64URL_32_BYTES);
        assert.deepEqual(releaseKeyFromSeed(seed), releaseKeyPublic);
    });

    it('derives the public key that verifies what the seed signs', () => {
        const seed = Buffer.alloc(32, 7).toString('base64url');
        const { publicKey } = releaseKeyFromSeed(seed);
        const privateKey = createPrivateKey({
            key: { kty: 'OKP', crv: 'Ed25519', d: seed, x: publicKey },
            format: 'jwk',
        });
        const signature = sign(null, Buffer.from('pae'), privateKey);
        const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
        assert.ok(verify(null, Buffer.from('pae'), pub, signature));
    });

    it('matches RFC 8032 test vector 1', () => {
        const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
        const expected = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
        assert.equal(releaseKeyFromSeed(seed.toString('base64url')).publicKey, expected.toString('base64url'));
    });

    it('refuses a seed that is not 32 bytes', () => {
        assert.throws(() => releaseKeyFromSeed('AAAA'), RangeError);
    });
});
