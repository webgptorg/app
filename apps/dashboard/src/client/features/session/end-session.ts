import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import type { AnyRouter } from '@tanstack/react-router';
import { useCallback } from 'react';

import { apiRoutes } from '../../../shared/api/routes';
import type { SessionView } from '../../../shared/api/routes';
import { queryKeys } from '../../api/queries';
import { useApiClient } from '../../api/api-client-context';
import { useLocale } from '../../i18n/locale';
import { safeReturnTo } from './return-to';

/**
 * Forgets everything the signed-in session loaded, then goes to sign-in. The session entry is set to `null` rather
 * than removed, so the sign-in route's guard sees "signed out" without asking the server again.
 */
export async function leaveSignedInArea(queryClient: QueryClient, router: AnyRouter, returnTo?: string): Promise<void> {
    queryClient.setQueryData(queryKeys.session, null);
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.session[0] });
    await router.navigate({ to: '/signin', search: returnTo === undefined ? {} : { returnTo }, replace: true });
}

/** For the query client's 401 handler: the session ended elsewhere, so come back here after signing in again. */
export function createSessionEndedHandler(queryClient: QueryClient, getRouter: () => AnyRouter): () => void {
    let leaving = false;
    return () => {
        if (leaving) {
            return;
        }
        leaving = true;
        const router = getRouter();
        void leaveSignedInArea(queryClient, router, safeReturnTo(router.state.location.href)).finally(() => {
            leaving = false;
        });
    };
}

/** Ends this session on the server; false when that could not be confirmed, and the session is then intact. */
export function useSignOut(): () => Promise<boolean> {
    const api = useApiClient();
    const queryClient = useQueryClient();
    const router = useRouter();
    return useCallback(async () => {
        const outcome = await api.call(apiRoutes.signout, {});
        const ended = outcome.kind === 'ok' || (outcome.kind === 'problem' && outcome.code === 'unauthorized');
        if (ended) {
            await leaveSignedInArea(queryClient, router);
        }
        return ended;
    }, [api, queryClient, router]);
}

/**
 * After sign-up, sign-in or recovery: the new session becomes the cached one. With a destination (sign-in, sign-up),
 * the person lands there and the account's saved language applies. Recovery stays on its end screen and keeps the
 * language it was done in: switching would re-render the tree and lose that screen.
 */
export function useCompleteSignIn(): (session: SessionView, returnTo?: string) => Promise<void> {
    const queryClient = useQueryClient();
    const router = useRouter();
    const { locale, changeLocale } = useLocale();
    return useCallback(
        async (session, returnTo) => {
            queryClient.removeQueries();
            queryClient.setQueryData(queryKeys.session, session);
            if (returnTo === undefined) {
                return;
            }
            await router.navigate({ href: returnTo, replace: true });
            if (session.user.locale !== locale) {
                changeLocale(session.user.locale);
            }
        },
        [queryClient, router, locale, changeLocale],
    );
}
