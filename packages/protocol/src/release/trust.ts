import { z } from 'zod';

import { Ed25519PublicKey } from '../ids';

export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Spec, Residual risks 2: regular releases install after 72 h, security fixes after 24 h, nothing sooner. Exact for
 * production policies; a staging policy may shorten them ({@link StagingTrustPolicy}).
 */
export const RELEASE_DELAYS = Object.freeze({ regularMs: 72 * HOUR_MS, securityMs: 24 * HOUR_MS } as const);
export const SECURITY_THRESHOLD = 2;
export const MAINTAINER_KEY_COUNT = 3;
export const MAX_RELEASE_KEYS = 8;

/** A trusted key. Its DSSE key ID is always derived (`dsseKeyId`), never stored beside it. */
export const KeyRef = z.strictObject({ publicKey: Ed25519PublicKey });
export type KeyRef = z.infer<typeof KeyRef>;

/** The release workflow's GitHub identity, pinned exactly (ADR 0014). */
export const WorkflowIdentity = z.strictObject({
    issuer: z.literal(GITHUB_ACTIONS_ISSUER),
    /** `owner/name`, spelled as GitHub puts it into the certificate SAN. */
    repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/),
    /** GitHub's numeric repository ID, which survives renames and transfers, unlike the name. */
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml$/),
});
export type WorkflowIdentity = z.infer<typeof WorkflowIdentity>;

/**
 * Who may sign the revocation list: at least `threshold` distinct keys from the named set. Not fixed by the spec; the
 * default is the release key or any one maintainer, because stopping a release is the safe direction.
 */
export const RevocationRule = z.strictObject({
    signers: z.enum(['release-or-maintainer', 'release', 'maintainer']),
    threshold: z
        .int()
        .min(1)
        .max(MAX_RELEASE_KEYS + MAINTAINER_KEY_COUNT),
});
export type RevocationRule = z.infer<typeof RevocationRule>;

export const DEFAULT_REVOCATION_RULE: RevocationRule = Object.freeze({
    signers: 'release-or-maintainer',
    threshold: 1,
});

/** The shortest delay a staging policy may set: still a real wait, so staging keeps exercising the delay path. */
export const STAGING_MIN_DELAY_MS = 60 * 1000;

const stagingDelay = (productionMs: number) => z.int().min(STAGING_MIN_DELAY_MS).max(productionMs);

const policyFields = {
    releaseKeys: z.array(KeyRef).min(1).max(MAX_RELEASE_KEYS),
    maintainerKeys: z.array(KeyRef).length(MAINTAINER_KEY_COUNT),
    securityThreshold: z.literal(SECURITY_THRESHOLD),
    workflowIdentity: WorkflowIdentity,
    revocationRule: RevocationRule,
};

interface PolicyKeys {
    readonly releaseKeys: readonly KeyRef[];
    readonly maintainerKeys: readonly KeyRef[];
    readonly revocationRule: RevocationRule;
}

function checkKeys(policy: PolicyKeys, context: z.RefinementCtx): void {
    const release = policy.releaseKeys.map(({ publicKey }) => publicKey);
    const maintainers = policy.maintainerKeys.map(({ publicKey }) => publicKey);
    // Canonical base64url: equal strings are equal keys and vice versa.
    if (new Set(release).size !== release.length) {
        context.addIssue({ code: 'custom', path: ['releaseKeys'], message: 'release keys must be distinct' });
    }
    if (new Set(maintainers).size !== maintainers.length) {
        context.addIssue({ code: 'custom', path: ['maintainerKeys'], message: 'maintainer keys must be distinct' });
    }
    if (maintainers.some((key) => release.includes(key))) {
        context.addIssue({
            code: 'custom',
            path: ['maintainerKeys'],
            message: 'a key may not be both a release and a maintainer key',
        });
    }
    if (policy.revocationRule.threshold > revocationSigners(policy).length) {
        context.addIssue({
            code: 'custom',
            path: ['revocationRule', 'threshold'],
            message: 'revocation threshold exceeds the keys allowed to sign',
        });
    }
}

/**
 * What a production engine trusts for releases: no `profile`, and exactly the spec's delays. Release and maintainer
 * keys never overlap and the three maintainer keys are distinct, so one person's key can never count twice toward a
 * threshold.
 */
export const ProductionTrustPolicy = z
    .strictObject({
        ...policyFields,
        delays: z.strictObject({
            regularMs: z.literal(RELEASE_DELAYS.regularMs),
            securityMs: z.literal(RELEASE_DELAYS.securityMs),
        }),
    })
    .superRefine(checkKeys);
export type ProductionTrustPolicy = z.infer<typeof ProductionTrustPolicy>;

/**
 * A staging engine's policy: the same keys and rules, but delays from {@link STAGING_MIN_DELAY_MS} up to the production
 * ones, so UI releases can be tried within minutes. It only ever shortens the wait, never widens what is trusted, and
 * production engines refuse it (`isStagingPolicy`).
 */
export const StagingTrustPolicy = z
    .strictObject({
        ...policyFields,
        profile: z.literal('staging'),
        delays: z.strictObject({
            regularMs: stagingDelay(RELEASE_DELAYS.regularMs),
            securityMs: stagingDelay(RELEASE_DELAYS.securityMs),
        }),
    })
    .superRefine(checkKeys)
    .superRefine(({ delays }, context) => {
        if (delays.securityMs > delays.regularMs) {
            context.addIssue({
                code: 'custom',
                path: ['delays', 'securityMs'],
                message: 'a security release may not wait longer than a regular one',
            });
        }
    });
export type StagingTrustPolicy = z.infer<typeof StagingTrustPolicy>;

/** What an engine trusts for releases: a production policy, or a staging one that only a non-production build accepts. */
export const TrustPolicy = z.union([ProductionTrustPolicy, StagingTrustPolicy]);
export type TrustPolicy = z.infer<typeof TrustPolicy>;

/** A production engine must refuse a policy for which this holds, before it trusts anything under it. */
export function isStagingPolicy(policy: TrustPolicy): policy is StagingTrustPolicy {
    return 'profile' in policy;
}

export function revocationSigners(policy: PolicyKeys): readonly KeyRef[] {
    switch (policy.revocationRule.signers) {
        case 'release':
            return policy.releaseKeys;
        case 'maintainer':
            return policy.maintainerKeys;
        case 'release-or-maintainer':
            return [...policy.releaseKeys, ...policy.maintainerKeys];
    }
}
