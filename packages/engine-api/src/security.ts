import { z } from 'zod';

import { Hostname, SemVer, Sha256Hex, Timestamp } from './common';
import { UpdatePolicyName } from './settings';
import { defineRoute } from './route';

const RekorLogIndex = z.int().min(0);

/** What the owner needs to check the engine without trusting us (spec, Transparency and verifiability 3). */
export const SecurityOverview = z.strictObject({
    engine: z.strictObject({ version: SemVer, releaseLogIndex: RekorLogIndex.nullable() }),
    update: z.strictObject({
        status: z.enum(['none', 'available', 'pending', 'installing']),
        policy: UpdatePolicyName,
        pinnedVersion: SemVer.nullable(),
        availableVersion: SemVer.nullable(),
        eligibleAt: Timestamp.nullable(),
    }),
    ui: z.strictObject({ version: SemVer, bundleSha256: Sha256Hex, releaseLogIndex: RekorLogIndex.nullable() }),
    tls: z.strictObject({
        /** Compare with the fingerprint the browser's padlock shows. */
        certificateSha256: Sha256Hex,
        notAfter: Timestamp,
        lastCtCheck: z
            .strictObject({ at: Timestamp, result: z.enum(['ok', 'unexpected-certificate', 'failed']) })
            .nullable(),
    }),
    relays: z.array(
        z.strictObject({
            hostname: Hostname,
            status: z.enum(['connected', 'connecting', 'disconnected']),
            since: Timestamp,
        }),
    ),
    hostnames: z.array(z.strictObject({ hostname: Hostname, kind: z.enum(['default', 'custom']) })),
    /** `body` is the exact text of the last heartbeat sent, byte for byte. */
    lastHeartbeat: z.strictObject({ sentAt: Timestamp, body: z.string() }).nullable(),
    outboundDestinations: z.array(z.string().min(1).max(2048)),
});
export type SecurityOverview = z.infer<typeof SecurityOverview>;

export const SECURITY_ROUTES = {
    getSecurityOverview: defineRoute({
        id: 'getSecurityOverview',
        method: 'GET',
        path: '/security',
        summary: 'Security panel: versions, release log entries, certificate, relays, last heartbeat',
        permission: 'security.read',
        responses: { 200: { kind: 'json', schema: SecurityOverview } },
    }),
} as const;
