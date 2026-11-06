import { generateLinkCode, type LinkCode } from '@ptbk/protocol';

import { sha256Hex } from '../auth/secrets';
import { newLinkCodeId, type LinkCodeId, type OrgId, type UserId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Random } from '../ports/random';
import type { EngineCreationPolicy, LinkCodeDenial } from './engine-creation-policy';
import type { LinkCodeStore } from './link-code-store';

/**
 * The default and the longest a deployment may configure (`LINK_CODE_TTL_S`): 30 days, because people install the
 * engine later, not in the same sitting. Single use, cancel and the fingerprint check bound what a leaked code can do.
 */
export const LINK_CODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssueLinkCodeDeps {
    readonly linkCodes: Pick<LinkCodeStore, 'insert'>;
    readonly policy: Pick<EngineCreationPolicy, 'checkLinkCode'>;
    readonly random: Random;
    readonly clock: Clock;
    readonly linkCodeTtlMs: number;
}

export type IssueLinkCodeOutcome =
    | {
          readonly kind: 'issued';
          readonly linkCodeId: LinkCodeId;
          readonly linkCode: LinkCode;
          readonly expiresAt: number;
      }
    | { readonly kind: 'denied'; readonly reason: LinkCodeDenial };

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
    const expiresAt = now + deps.linkCodeTtlMs;
    const linkCodeId = newLinkCodeId(deps.random);
    await deps.linkCodes.insert({
        id: linkCodeId,
        codeHash: await sha256Hex(linkCode),
        orgId: issuer.orgId,
        createdByUserId: issuer.userId,
        createdAt: now,
        expiresAt,
    });
    return { kind: 'issued', linkCodeId, linkCode, expiresAt };
}
