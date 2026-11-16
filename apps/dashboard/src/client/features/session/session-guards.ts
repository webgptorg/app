import { notFound, redirect } from '@tanstack/react-router';
import type { ParsedLocation } from '@tanstack/react-router';

import type { SessionView } from '../../../shared/api/routes';
import { sessionQuery } from '../../api/queries';
import type { RouterContext } from '../../core/router-context';
import { safeReturnTo } from './return-to';

/** Cached for the query's stale time, so navigating does not ask the server every time; a 401 anywhere ends it. */
function currentSession(context: RouterContext): Promise<SessionView | null> {
    return context.queryClient.query(sessionQuery(context.apiClient));
}

/** `beforeLoad` of the signed-in area: no session sends the visitor to sign in, and back here afterwards. */
export async function requireSession(
    context: RouterContext,
    location: ParsedLocation,
): Promise<{ readonly session: SessionView }> {
    const session = await currentSession(context);
    if (session === null) {
        const returnTo = safeReturnTo(location.href);
        throw redirect({ to: '/continue', search: returnTo === undefined ? {} : { returnTo }, replace: true });
    }
    return { session };
}

/** `beforeLoad` of sign-in and sign-up: someone already signed in has nothing to do there. */
export async function redirectIfSignedIn(context: RouterContext): Promise<void> {
    if ((await currentSession(context)) !== null) {
        throw redirect({ to: '/', replace: true });
    }
}

/**
 * Platform admin is a platform role, not an org permission, so `GET /api/session` carries it as the role itself. This
 * is the only place the SPA reads it; the server checks it again on every admin endpoint.
 */
export function isPlatformAdmin(session: SessionView): boolean {
    return session.user.platformRole === 'admin';
}

/** `/admin` answers "not found" to everyone else, so its existence says nothing about who is an admin. */
export function requirePlatformAdmin(session: SessionView): void {
    if (!isPlatformAdmin(session)) {
        throw notFound();
    }
}

/** With billing off the billing screens do not exist, the same 404 the server gives for their API. */
export function requireBilling(session: SessionView): void {
    if (!session.billingEnabled) {
        throw notFound();
    }
}
