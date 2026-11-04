// The secrets staging generates itself (docs/staging-runbook.md, Secrets), in the formats their consumers parse:
// apps/dashboard/src/app/config.ts, the relay's metrics token, X-03's release key and OpenTofu's state passphrase.
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';

export interface GeneratedSecret {
    readonly name: string;
    readonly value: string;
    readonly goesTo: readonly string[];
}

export interface StagingSecrets {
    readonly secrets: readonly GeneratedSecret[];
    /** Public, so it is printed apart from the secrets: it goes into a reviewed PR. */
    readonly releaseKeyPublic: { readonly publicKey: string; readonly keyid: string };
}

/** RFC 8410's PKCS#8 prefix for an Ed25519 private key; the 32-byte seed follows it. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function randomBase64Url(bytes: number): string {
    return randomBytes(bytes).toString('base64url');
}

export function metricsToken(): string {
    return `ptbk_mt_${randomBase64Url(32)}`;
}

/** The public key and DSSE keyid for a base64url seed, as `release:keygen` prints them. */
export function releaseKeyFromSeed(seed: string): { publicKey: string; keyid: string } {
    const seedBytes = Buffer.from(seed, 'base64url');
    if (seedBytes.length !== 32) throw new RangeError('the release key seed must be 32 bytes');
    const privateKey = createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, seedBytes]),
        format: 'der',
        type: 'pkcs8',
    });
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    if (jwk.x === undefined) throw new Error('no public key in the exported JWK');
    const keyid = createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('base64url');
    return { publicKey: jwk.x, keyid };
}

export function generateStagingSecrets(relayHostnames: readonly string[]): StagingSecrets {
    if (relayHostnames.length === 0) throw new RangeError('at least one relay hostname is needed');
    const relayTokens = relayHostnames.map((hostname) => ({ hostname, token: metricsToken() }));
    const releaseSeed = randomBase64Url(32);
    return {
        secrets: [
            {
                name: 'TF_VAR_state_passphrase',
                value: randomBase64Url(32),
                goesTo: [
                    'Password manager. Losing it means rebuilding OpenTofu state by import.',
                    'export TF_VAR_state_passphrase=... before tofu in infra/cloudflare and infra/relay (one for both).',
                ],
            },
            {
                name: 'RATE_LIMIT_HMAC_KEY',
                value: randomBase64Url(32),
                goesTo: [
                    'Password manager.',
                    'cd apps/dashboard && bunx wrangler secret put RATE_LIMIT_HMAC_KEY --env staging',
                ],
            },
            {
                name: 'MEMBER_KEY',
                value: randomBase64Url(32),
                goesTo: ['Password manager.', 'cd apps/dashboard && bunx wrangler secret put MEMBER_KEY --env staging'],
            },
            ...relayTokens.map(({ hostname, token }) => ({
                name: `metrics-token (${hostname})`,
                value: token,
                goesTo: [
                    'Password manager.',
                    `The relay's /etc/ptbk-relay/credentials/metrics-token on ${hostname} (runbook, Relay).`,
                ],
            })),
            {
                name: 'RELAY_METRICS_TOKENS',
                value: JSON.stringify(Object.fromEntries(relayTokens.map(({ hostname, token }) => [hostname, token]))),
                goesTo: [
                    'The same tokens as one JSON object; nothing new to store.',
                    'cd apps/dashboard && bunx wrangler secret put RELAY_METRICS_TOKENS --env staging',
                ],
            },
            {
                name: 'UI_STAGING_RELEASE_KEY',
                value: releaseSeed,
                goesTo: [
                    'Password manager. With CI: the `release` GitHub environment secret of the same name.',
                    'Its public key (below) replaces releaseKeys[0] in apps/engine-ui/release/trust-policy.staging.json.',
                ],
            },
        ],
        releaseKeyPublic: releaseKeyFromSeed(releaseSeed),
    };
}
