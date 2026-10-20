import { z } from 'zod';

import type { Bytes } from '../bytes';
import { EngineVersion, Timestamp } from '../ids';
import { parseJsonPayload } from './json-payload';
import { versionPrecedenceKey } from './version';

export const MAX_REVOKED_VERSIONS = 1000;
export const MAX_REVOCATION_REASON_LENGTH = 500;

export const RevokedVersion = z.strictObject({
    version: EngineVersion,
    reason: z.string().max(MAX_REVOCATION_REASON_LENGTH),
});
export type RevokedVersion = z.infer<typeof RevokedVersion>;

/**
 * The DSSE payload of the revocation list (`REVOCATION_PAYLOAD_TYPE`). One list replaces individual entries so its
 * freshness can be checked. Versions are unique by SemVer precedence, the same rule `verifyRelease` matches them by.
 */
export const RevocationList = z
    .strictObject({
        v: z.literal(1),
        issuedAt: Timestamp,
        expiresAt: Timestamp,
        revoked: z.array(RevokedVersion).max(MAX_REVOKED_VERSIONS),
    })
    .refine((list) => Date.parse(list.expiresAt) > Date.parse(list.issuedAt), 'expiresAt must be after issuedAt')
    .refine(
        (list) =>
            new Set(list.revoked.map(({ version }) => versionPrecedenceKey(version))).size === list.revoked.length,
        'revoked versions must be unique',
    );
export type RevocationList = z.infer<typeof RevocationList>;

/** Strict UTF-8, JSON and schema; `undefined` for anything else. Call only after the signatures verified. */
export function parseRevocationList(payload: Bytes): RevocationList | undefined {
    return parseJsonPayload(payload, RevocationList);
}

export function findRevocation(list: RevocationList, version: EngineVersion): RevokedVersion | undefined {
    const key = versionPrecedenceKey(version);
    return list.revoked.find((entry) => versionPrecedenceKey(entry.version) === key);
}
