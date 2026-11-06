import type { Entitlements } from '../billing/entitlements';
import type { OrgId } from '../ids';
import type { Clock } from '../ports/clock';
import type { EngineStore } from './engine-store';
import type { LinkCodeStore } from './link-code-store';

const HOUR_MS = 60 * 60 * 1000;

export const LINK_CODE_LIMITS = { active: 5, perHour: 10 } as const;

export type EntitlementDenial = 'not-entitled' | 'engine-limit';

export type LinkCodeDenial = EntitlementDenial | 'link-code-limit' | 'rate-limited';

export type EngineCreationDecision<Reason extends string> =
    { readonly kind: 'allowed' } | { readonly kind: 'denied'; readonly reason: Reason };

/**
 * Whether an organization may add an engine. Plans, cards and the billing provider stay behind `Entitlements`
 * (ADR 0017); this enforces only the link-code rate limits itself.
 */
export interface EngineCreationPolicy {
    /**
     * Whether the link page should offer a code at all, or the plan step or the limit banner first (D-10). The
     * link-code limits are left to issuance, which answers them on its own.
     */
    checkEligibility(orgId: OrgId, signal: AbortSignal): Promise<EngineCreationDecision<EntitlementDenial>>;
    /**
     * Before a link code is issued, so the SPA shows the upgrade path before an install command. `link-code-limit`: the
     * organization holds as many unused codes as it may, which only cancelling one (or its expiry) frees.
     */
    checkLinkCode(orgId: OrgId, signal: AbortSignal): Promise<EngineCreationDecision<LinkCodeDenial>>;
    /**
     * Before a redeemed code creates an engine. The link-code limits do not apply again: the code being redeemed was
     * counted when it was issued, and counting it now would refuse the organization's own fifth code.
     */
    checkRegistration(orgId: OrgId, signal: AbortSignal): Promise<EngineCreationDecision<EntitlementDenial>>;
}

const ALLOWED = { kind: 'allowed' } as const;

export function createEngineCreationPolicy(deps: {
    readonly entitlements: Entitlements;
    readonly linkCodes: Pick<LinkCodeStore, 'countActive' | 'countIssuedSince'>;
    readonly engines: Pick<EngineStore, 'countActive'>;
    readonly clock: Clock;
}): EngineCreationPolicy {
    async function checkEntitlements(
        orgId: OrgId,
        signal: AbortSignal,
    ): Promise<EngineCreationDecision<EntitlementDenial>> {
        if (!(await deps.entitlements.allows(orgId, 'engines.create', signal))) {
            return { kind: 'denied', reason: 'not-entitled' };
        }
        const max = await deps.entitlements.limit(orgId, 'engines.max', signal);
        if (max !== null && (await deps.engines.countActive(orgId)) >= max) {
            return { kind: 'denied', reason: 'engine-limit' };
        }
        return ALLOWED;
    }

    return {
        async checkLinkCode(orgId, signal) {
            const entitled = await checkEntitlements(orgId, signal);
            if (entitled.kind === 'denied') {
                return entitled;
            }
            const now = deps.clock.nowMs();
            if ((await deps.linkCodes.countActive(orgId, now)) >= LINK_CODE_LIMITS.active) {
                return { kind: 'denied', reason: 'link-code-limit' };
            }
            if ((await deps.linkCodes.countIssuedSince(orgId, now - HOUR_MS)) >= LINK_CODE_LIMITS.perHour) {
                return { kind: 'denied', reason: 'rate-limited' };
            }
            return ALLOWED;
        },
        checkEligibility: checkEntitlements,
        checkRegistration: checkEntitlements,
    };
}
