import { notFound } from '@tanstack/react-router';

import { AccessDeniedError } from '../access-denied';
import type { RouterContext } from '../router-context';
import { loadAccess } from './engine-access';
import { requirementAccess } from './visibility';

const AGENT_TAB_PREFIX = '/agents/$agentId/';

/**
 * For agent tab paths no route serves: a tab some feature registers but the engine or the member does not allow
 * explains itself ("not available on this engine", "no access"), exactly as its own guarded route would; anything
 * else is not found. A tab's own route, once it exists, always takes precedence over this.
 */
export async function resolveUnservedAgentTab(context: RouterContext, segment: string): Promise<void> {
    const access = await loadAccess(context);
    for (const feature of context.features) {
        const tab = feature.agentTabs?.find((candidate) => candidate.to === `${AGENT_TAB_PREFIX}${segment}`);
        if (tab === undefined) continue;
        const verdict = requirementAccess(feature.requires, access);
        if (verdict !== 'allowed') throw new AccessDeniedError(verdict);
        const tabVerdict = requirementAccess(tab.requires, access);
        if (tabVerdict !== 'allowed') throw new AccessDeniedError(tabVerdict);
    }
    notFound({ throw: true });
}
