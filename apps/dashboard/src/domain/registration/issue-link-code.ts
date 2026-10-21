import { generateLinkCode, type LinkCode } from '@ptbk/protocol';

import { sha256Hex } from '../auth/secrets';
import type { OrgId, UserId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Random } from '../ports/random';
import type { EngineCreationPolicy, EntitlementDenial } from './engine-creation-policy';
import type { LinkCodeStore } from './link-code-store';

export const LINK_CODE_TTL_MS = 30 * 60 * 1000;

export interface IssueLinkCodeDeps {
    readonly linkCodes: Pick<LinkCodeStore, 'insert'>;
    readonly policy: Pick<EngineCreationPolicy, 'checkLinkCode'>;
    readonly random: Random;
    readonly clock: Clock;
}

export type IssueLinkCodeOutcome =
    | { readonly kind: 'issued'; readonly linkCode: LinkCode; readonly expiresAt: number }
    | { readonly kind: 'denied'; readonly reason: EntitlementDenial | 'rate-limited' };

/** The plaintext code exists only in this answer; the store keeps its SHA-256. */
export async function issueLinkCode(
    deps: IssueLinkCodeDeps,
    issuer: { readonly orgId: OrgId; readonly userId: UserId },
    signal: AbortSignal,
): Promise<IssueLinkCodeOutcome> {
    const decision = await deps.policy.checkLinkCode(issuer.orgId, signal);
    if (decision.kind === 'denied') {
        return decision;
    }
    // The protocol's Random wants bytes over a plain ArrayBuffer; a copy gives exactly that.
    const linkCode = generateLinkCode({ bytes: (length) => new Uint8Array(deps.random.bytes(length)) });
    const now = deps.clock.nowMs();
    const expiresAt = now + LINK_CODE_TTL_MS;
    await deps.linkCodes.insert({
        codeHash: await sha256Hex(linkCode),
        orgId: issuer.orgId,
        createdByUserId: issuer.userId,
        createdAt: now,
        expiresAt,
    });
    return { kind: 'issued', linkCode, expiresAt };
}
