import { z } from 'zod';

import { Hostname, SemVer, Sha256Hex, Timestamp } from './common';
import { UpdatePolicyName } from './settings';
import { defineRoute } from './route';
import { openEnum, toTolerant } from './tolerant';

const RekorLogIndex = z.int().min(0);

/** A Rekor entry UUID: 64 hex characters, prefixed by the 16-character tree ID on sharded logs. */
export const RekorEntryUuid = z.string().regex(/^(?:[0-9a-f]{16})?[0-9a-f]{64}$/);

/** Why the engine's UI loader refused a bundle: the first failed check of the release verification (C-06, M-05). */
export const UI_REFUSAL_REASONS = [
    'invalid-entry',
    'signature-threshold-not-met',
    'not-in-log',
    'revoked',
    'not-newer',
    'delay-not-elapsed',
    'hash-mismatch',
    'manifest',
    'engine-api',
    'unpack',
    'revocations-unverifiable',
] as const;
export type UiRefusalReason = (typeof UI_REFUSAL_REASONS)[number];

/** Why the revocation list could not be trusted, for `revocations-unverifiable`. */
export const UI_REVOCATION_REASONS = ['missing', 'invalid', 'expired', 'rolled-back'] as const;
export type UiRevocationReason = (typeof UI_REVOCATION_REASONS)[number];

export const UI_UPDATE_OUTCOMES = ['up-to-date', 'installed', 'refused', 'unavailable'] as const;

const uiUpdateCheckShape = {
    at: Timestamp,
    /** `refused` keeps the active bundle; `unavailable` means the release store could not be reached. */
    outcome: z.enum(UI_UPDATE_OUTCOMES),
    /** The version checked: the latest or the pinned one, verified or not; `null` when `unavailable`. */
    version: SemVer.nullable(),
    /** Set exactly when `outcome` is `refused`. */
    reason: z.enum(UI_REFUSAL_REASONS).nullable(),
    /** Set exactly when `reason` is `revocations-unverifiable`. */
    revocationReason: z.enum(UI_REVOCATION_REASONS).nullable(),
};

/** The UI loader's last update check, so a refused or unverifiable release shows in the panel, not only in logs. */
export const UiUpdateCheck = z.strictObject(uiUpdateCheckShape);
export type UiUpdateCheck = z.infer<typeof UiUpdateCheck>;

/** A certificate for one of the engine's hostnames that the engine did not request, found in CT logs. */
export const UnexpectedCertificate = z.strictObject({
    sha256: Sha256Hex,
    /** From the certificate, so untrusted text: render it as text only. */
    issuer: z.string().min(1).max(512),
    notBefore: Timestamp,
    notAfter: Timestamp,
});
export type UnexpectedCertificate = z.infer<typeof UnexpectedCertificate>;
export const MAX_UNEXPECTED_CERTIFICATES = 16;

export const CERTIFICATE_STATUSES = ['valid', 'pending', 'expiring', 'expired', 'error'] as const;

const uiStatusShape = {
    version: SemVer,
    bundleSha256: Sha256Hex,
    releaseLogIndex: RekorLogIndex.nullable(),
    releaseLogEntryUuid: RekorEntryUuid.nullable().default(null),
    /** `null` until the loader has checked once (and from engines on API 1.2). */
    lastUpdateCheck: UiUpdateCheck.nullable().default(null),
};

const hostnameShape = {
    hostname: Hostname,
    kind: z.enum(['default', 'custom']),
    /** The hostname's own TLS certificate; `null` from engines on API 1.2. */
    certificateStatus: z.enum(CERTIFICATE_STATUSES).nullable().default(null),
    /** Whether the dashboard holds the engine's signed claim for this custom domain; always `null` for the default one. */
    claimRegistered: z.boolean().nullable().default(null),
};

const securityOverviewShape = {
    engine: z.strictObject({
        version: SemVer,
        releaseLogIndex: RekorLogIndex.nullable(),
        releaseLogEntryUuid: RekorEntryUuid.nullable().default(null),
    }),
    update: z.strictObject({
        status: z.enum(['none', 'available', 'pending', 'installing']),
        policy: UpdatePolicyName,
        pinnedVersion: SemVer.nullable(),
        availableVersion: SemVer.nullable(),
        eligibleAt: Timestamp.nullable(),
    }),
    ui: z.strictObject(uiStatusShape),
    tls: z.strictObject({
        /** Compare with the fingerprint the browser's padlock shows. */
        certificateSha256: Sha256Hex,
        notAfter: Timestamp,
        lastCtCheck: z
            .strictObject({
                at: Timestamp,
                result: z.enum(['ok', 'unexpected-certificate', 'failed']),
                /** What `unexpected-certificate` found; empty otherwise. */
                unexpectedCertificates: z.array(UnexpectedCertificate).max(MAX_UNEXPECTED_CERTIFICATES).default([]),
            })
            .nullable(),
    }),
    relays: z.array(
        z.strictObject({
            hostname: Hostname,
            status: z.enum(['connected', 'connecting', 'disconnected']),
            since: Timestamp,
            /** Round trip of the last tunnel ping; `null` before the first answer (and from engines on API 1.2). */
            lastPingRttMs: z.int().min(0).max(600_000).nullable().default(null),
        }),
    ),
    hostnames: z.array(z.strictObject(hostnameShape)),
    /**
     * `body` is the exact text of the last heartbeat sent, byte for byte; `signature` the exact `Ptbk-Signature` header
     * value sent with it (`null` from engines on API 1.2).
     */
    lastHeartbeat: z
        .strictObject({
            sentAt: Timestamp,
            body: z.string(),
            signature: z.string().min(1).max(256).nullable().default(null),
        })
        .nullable(),
    /**
     * The engine's clock minus the dashboard's, in seconds, as measured when the dashboard refused a heartbeat as stale;
     * `null` while unknown or since a heartbeat was accepted again.
     */
    clockSkew: z.strictObject({ seconds: z.int(), measuredAt: Timestamp }).nullable().default(null),
    outboundDestinations: z.array(z.string().min(1).max(2048)),
};

/** What the owner needs to check the engine without trusting us (spec, Transparency and verifiability 3). */
export const SecurityOverview = z.strictObject(securityOverviewShape);
export type SecurityOverview = z.infer<typeof SecurityOverview>;

/**
 * The overview as the client reads it: a refusal reason, revocation reason, check outcome or certificate status this
 * contract does not know yet (a newer engine's) reads as `unknown`, so the panel shows it instead of failing.
 */
export const SecurityOverviewReader = toTolerant(
    z.strictObject({
        ...securityOverviewShape,
        ui: z.strictObject({
            ...uiStatusShape,
            lastUpdateCheck: z
                .strictObject({
                    ...uiUpdateCheckShape,
                    outcome: openEnum(UI_UPDATE_OUTCOMES),
                    reason: openEnum(UI_REFUSAL_REASONS).nullable(),
                    revocationReason: openEnum(UI_REVOCATION_REASONS).nullable(),
                })
                .nullable()
                .default(null),
        }),
        hostnames: z.array(
            z.strictObject({
                ...hostnameShape,
                certificateStatus: openEnum(CERTIFICATE_STATUSES).nullable().default(null),
            }),
        ),
    }),
);
export type ReadSecurityOverview = z.output<typeof SecurityOverviewReader>;

export const SECURITY_ROUTES = {
    getSecurityOverview: defineRoute({
        id: 'getSecurityOverview',
        method: 'GET',
        path: '/security',
        summary: 'Security panel: versions, release log entries, certificate, relays, last heartbeat',
        permission: 'security.read',
        responses: { 200: { kind: 'json', schema: SecurityOverview, read: SecurityOverviewReader } },
    }),
} as const;
