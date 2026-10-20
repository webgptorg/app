import { supports } from '@ptbk/engine-api';
import type { CapabilityRef, EngineInfo } from '@ptbk/engine-api';

import { createCan } from '../../features/session/permissions';
import { engineInfoQueryOptions } from '../../features/engine/engine-queries';
import { meQueryOptions } from '../../features/session/session-queries';
import type { RouterContext } from '../router-context';
import type { Access } from './visibility';

export function accessFrom(engine: Pick<EngineInfo, 'capabilities'>, permissions: readonly string[]): Access {
    return {
        can: createCan(permissions),
        supports: (capability: CapabilityRef) => supports(engine, capability),
    };
}

/** For guards and redirects outside React: the engine's capabilities and the member's permissions, from the cache. */
export async function loadAccess(context: RouterContext): Promise<Access> {
    const [engine, me] = await Promise.all([
        context.queryClient.query({ ...engineInfoQueryOptions(context.engineApi), staleTime: 'static' }),
        context.queryClient.query({ ...meQueryOptions(context.engineApi), staleTime: 'static' }),
    ]);
    return accessFrom(engine, me.permissions);
}
