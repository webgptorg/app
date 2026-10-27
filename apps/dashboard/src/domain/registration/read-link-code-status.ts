import type { EngineId, Hostname } from '@ptbk/protocol';

import type { LinkCodeId, OrgId } from '../ids';
import type { Clock } from '../ports/clock';
import type { EngineStore } from './engine-store';
import type { LinkCodeStore } from './link-code-store';

export type LinkCodeStatus =
    | { readonly kind: 'pending'; readonly expiresAt: number }
    | { readonly kind: 'expired' }
    | { readonly kind: 'linked'; readonly engineId: EngineId; readonly hostname: Hostname }
    | { readonly kind: 'not-found' };

/**
 * What the link page shows for one of the organization's codes (D-10). Both reads are scoped by the organization, so
 * another organization's code ID is `not-found`, exactly like one that does not exist.
 */
export async function readLinkCodeStatus(
    deps: {
        readonly linkCodes: Pick<LinkCodeStore, 'findState'>;
        readonly engines: Pick<EngineStore, 'findInOrg'>;
        readonly clock: Clock;
    },
    orgId: OrgId,
    linkCodeId: LinkCodeId,
): Promise<LinkCodeStatus> {
    const state = await deps.linkCodes.findState(orgId, linkCodeId, deps.clock.nowMs());
    if (state === null) {
        return { kind: 'not-found' };
    }
    if (state.kind !== 'linked') {
        return state;
    }
    const engine = await deps.engines.findInOrg(orgId, state.engineId);
    return engine === null
        ? { kind: 'not-found' }
        : { kind: 'linked', engineId: engine.engineId, hostname: engine.hostname };
}
