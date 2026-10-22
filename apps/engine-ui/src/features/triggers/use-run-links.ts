import { KNOWN_CAPABILITIES, supports } from '@ptbk/engine-api';

import { useEngineCapabilities } from '../../app/registry/use-visible-features';
import { usePermissions } from '../session/use-permissions';

/** A fire links to its run only where the engine serves runs (`runs@1`) and the member may read them. */
export function useRunLinks(): boolean {
    const capabilities = useEngineCapabilities();
    const { can } = usePermissions();
    return supports({ capabilities }, KNOWN_CAPABILITIES.runs) && can('runs.read');
}
