import type { TrustPolicy } from '@ptbk/protocol';
import {
    DsseEnvelope,
    REVOCATION_MAX_VALIDITY_MS,
    REVOCATION_PAYLOAD_TYPE,
    RevocationList,
    dsseKeyId,
    dssePayload,
    ed25519PublicKeyFromBytes,
    ed25519PublicKeyToBytes,
    parseRevocationList,
    revocationSigners,
    signDsse,
    verifyDsseSignatures,
} from '@ptbk/protocol';

import { ReleaseKeyError, releaseSignerFromSeed } from './signed-release.ts';

export class RevocationListError extends Error {
    override readonly name = 'RevocationListError';
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_VALID_DAYS = REVOCATION_MAX_VALIDITY_MS / DAY_MS;

export interface Revocation {
    readonly version: string;
    readonly reason: string;
}

export interface IssueRevocationListInput {
    readonly seed: string;
    readonly policy: TrustPolicy;
    readonly now: Date;
    readonly validDays: number;
    /** The currently published envelope as fetched, or `null` for the very first list. */
    readonly previous: unknown;
    readonly revoke: readonly Revocation[];
}

export interface IssuedRevocationList {
    readonly envelope: DsseEnvelope;
    readonly list: RevocationList;
    readonly keyId: string;
}

/** The list inside an envelope, if it is signed as `verifyRelease` requires; freshness is not checked. */
export async function readRevocationList(envelope: unknown, policy: TrustPolicy): Promise<RevocationList | undefined> {
    const parsed = DsseEnvelope.safeParse(envelope);
    if (!parsed.success || parsed.data.payloadType !== REVOCATION_PAYLOAD_TYPE) return undefined;
    const keys = revocationSigners(policy).map(({ publicKey }) => ed25519PublicKeyToBytes(publicKey));
    const valid = await verifyDsseSignatures(parsed.data, keys);
    if (valid.size < policy.revocationRule.threshold) return undefined;
    return parseRevocationList(dssePayload(parsed.data));
}

/**
 * Issues the next revocation list. Every version the previous list revokes is carried forward, because a re-signed list
 * that dropped one would quietly un-revoke it; and a list issued before the previous one is refused, because every
 * engine that accepted the previous list would refuse it as rolled back.
 */
export async function issueRevocationList(input: IssueRevocationListInput): Promise<IssuedRevocationList> {
    if (!Number.isInteger(input.validDays) || input.validDays < 1 || input.validDays > MAX_VALID_DAYS) {
        throw new RevocationListError(`a list is valid for 1 to ${String(MAX_VALID_DAYS)} whole days`);
    }
    const signer = await releaseSignerFromSeed(input.seed);
    const publicKey = ed25519PublicKeyFromBytes(signer.publicKey());
    if (!revocationSigners(input.policy).some((key) => key.publicKey === publicKey)) {
        throw new ReleaseKeyError('the trust policy does not let this key sign revocation lists');
    }
    if (input.policy.revocationRule.threshold > 1) {
        throw new RevocationListError(
            `the trust policy needs ${String(input.policy.revocationRule.threshold)} signatures; this command signs with one key`,
        );
    }
    let carried: readonly Revocation[] = [];
    if (input.previous !== null) {
        const previous = await readRevocationList(input.previous, input.policy);
        if (previous === undefined) {
            throw new RevocationListError('the previous list does not verify under the trust policy');
        }
        if (Date.parse(previous.issuedAt) > input.now.getTime()) {
            throw new RevocationListError(
                `the previous list was issued at ${previous.issuedAt}, after now; engines would refuse this one as rolled back`,
            );
        }
        carried = previous.revoked;
    }
    const list = RevocationList.safeParse({
        v: 1,
        issuedAt: input.now.toISOString(),
        expiresAt: new Date(input.now.getTime() + input.validDays * DAY_MS).toISOString(),
        revoked: [...carried, ...input.revoke],
    });
    if (!list.success) {
        throw new RevocationListError(
            list.error.issues.map(({ path, message }) => [...path.map(String), message].join(': ')).join('; '),
        );
    }
    const payload = new TextEncoder().encode(JSON.stringify(list.data));
    const envelope = await signDsse(signer, REVOCATION_PAYLOAD_TYPE, payload);
    return { envelope, list: list.data, keyId: await dsseKeyId(signer.publicKey()) };
}

/** `--revoke <version>=<reason>`. */
export function parseRevokeArgument(text: string): Revocation {
    const separator = text.indexOf('=');
    if (separator <= 0 || separator === text.length - 1) {
        throw new RevocationListError(`--revoke takes <version>=<reason>, got "${text}"`);
    }
    return { version: text.slice(0, separator), reason: text.slice(separator + 1) };
}

export function parseValidDays(text: string | undefined): number {
    if (text === undefined) return MAX_VALID_DAYS;
    if (!/^\d+$/.test(text)) throw new RevocationListError(`--valid-days takes whole days, got "${text}"`);
    return Number(text);
}
