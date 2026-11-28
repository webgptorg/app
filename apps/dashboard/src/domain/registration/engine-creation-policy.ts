import type { Entitlements } from '../billing/entitlements';
import type { OrgId } from '../ids';
import { OPEN_LICENSE_GATE, type LicenseGate } from '../licensing/license-service';
import type { EngineStore } from './engine-store';

export type EntitlementDenial = 'not-entitled' | 'engine-limit';

type EngineCreationDecision =
    | { readonly kind: 'allowed'; readonly maxActiveEngines: number | null }
    | { readonly kind: 'denied'; readonly reason: EntitlementDenial };

/**
 * Whether an organization may add an engine. Plans, cards and the billing provider stay behind `Entitlements`
 * (ADR 0017). The link-code store enforces issuance quotas when it writes each code.
 */
export interface EngineCreationPolicy {
    /**
     * Whether the link page should offer a code at all, or the plan step or the limit banner first (D-10). The
     * link-code limits are left to issuance, which answers them on its own.
     */
    checkEligibility(orgId: OrgId, signal: AbortSignal): Promise<EngineCreationDecision>;
    /** Entitlements for a new engine. Issuance already counted the code being redeemed. */
    checkRegistration(orgId: OrgId, signal: AbortSignal): Promise<EngineCreationDecision>;
}

export function createEngineCreationPolicy(deps: {
    readonly entitlements: Entitlements;
    readonly engines: Pick<EngineStore, 'countActive'>;
    /** The `engine.link` check point; it denies only with `LICENSE_ENFORCEMENT` `enforce`. */
    readonly licenseGate?: LicenseGate;
}): EngineCreationPolicy {
    const licenseGate = deps.licenseGate ?? OPEN_LICENSE_GATE;

    async function checkEntitlements(orgId: OrgId, signal: AbortSignal): Promise<EngineCreationDecision> {
        if (!(await deps.entitlements.allows(orgId, 'engines.create', signal))) {
            return { kind: 'denied', reason: 'not-entitled' };
        }
        const max = await deps.entitlements.limit(orgId, 'engines.max', signal);
        if (max !== null && (await deps.engines.countActive(orgId)) >= max) {
            return { kind: 'denied', reason: 'engine-limit' };
        }
        return { kind: 'allowed', maxActiveEngines: max };
    }

    // Asked when someone links, never when an engine redeems a code it already holds: an install under way finishes.
    async function checkLinking(orgId: OrgId, signal: AbortSignal): Promise<EngineCreationDecision> {
        const entitled = await checkEntitlements(orgId, signal);
        if (entitled.kind === 'denied') {
            return entitled;
        }
        const license = await licenseGate.check('engine.link', orgId, signal);
        if (license.outcome !== 'deny') {
            return entitled;
        }
        return { kind: 'denied', reason: license.reason === 'over-limit' ? 'engine-limit' : 'not-entitled' };
    }

    return {
        checkEligibility: checkLinking,
        checkRegistration: checkEntitlements,
    };
}
