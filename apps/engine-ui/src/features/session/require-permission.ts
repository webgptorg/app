import type { Permission } from '@ptbk/engine-api';

import { AccessDeniedError } from '../../app/access-denied';
import type { RouterContext } from '../../app/router-context';
import { createCan } from './permissions';
import { meQueryOptions } from './session-queries';

/** For a route's `beforeLoad`: shows the "no access" page unless the member holds `permission`. */
export function requirePermission(permission: Permission) {
    return async ({ context }: { readonly context: RouterContext }): Promise<void> => {
        const me = await context.queryClient.query({ ...meQueryOptions(context.engineApi), staleTime: 'static' });
        if (!createCan(me.permissions)(permission)) throw new AccessDeniedError('no-access');
    };
}
