import { navSections } from '../../features/shell/nav-groups';
import type { RouterContext } from '../router-context';
import { loadAccess } from './engine-access';
import type { RoutePath } from './feature';
import { visibleFeatures } from './visibility';

/** The first sidebar entry the member can open; Settings is always there. */
export async function firstNavPath(context: RouterContext): Promise<RoutePath> {
    const visible = visibleFeatures(context.features, await loadAccess(context));
    return navSections(visible)[0]?.items[0]?.to ?? '/settings';
}
