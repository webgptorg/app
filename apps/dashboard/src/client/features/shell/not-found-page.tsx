import { useQuery } from '@tanstack/react-query';

import { sessionQuery } from '../../api/queries';
import { useApiClient } from '../../api/api-client-context';
import { RouteNotFound } from '../../core/route-states';
import { AuthFrame } from '../auth/auth-layout';
import { AppFrame } from './app-shell';

/**
 * An unknown URL matches neither layout, and `/admin` refuses non-admins from its `beforeLoad`, so both land on the
 * root. Someone who is lost needs their navigation most: the page asks for the session and keeps the matching frame.
 */
export function NotFoundPage() {
    const { data: session, isPending } = useQuery(sessionQuery(useApiClient()));
    if (isPending) {
        return null;
    }
    if (session === undefined || session === null) {
        return (
            <AuthFrame>
                <RouteNotFound />
            </AuthFrame>
        );
    }
    return (
        <AppFrame session={session}>
            <RouteNotFound />
        </AppFrame>
    );
}
