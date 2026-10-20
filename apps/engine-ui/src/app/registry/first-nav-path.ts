import { createCan } from '../../features/session/permissions';
import { meQueryOptions } from '../../features/session/session-queries';
import { navSections } from '../../features/shell/nav-groups';
import type { RouterContext } from '../router-context';
import type { RoutePath } from './feature';
import { visibleFeatures } from './visibility';

/** The first sidebar entry the member can open; Settings is always there. */
export async function firstNavPath(context: RouterContext): Promise<RoutePath> {
    const me = await context.queryClient.query({ ...meQueryOptions(context.engineApi), staleTime: 'static' });
    const visible = visibleFeatures(context.features, { can: createCan(me.permissions) });
    return navSections(visible)[0]?.items[0]?.to ?? '/settings';
}
