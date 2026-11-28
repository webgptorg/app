import { Hono } from 'hono';

import { notificationIdSchema } from '../../domain/ids';
import {
    markInboxSeen,
    readInbox,
    readPreferences,
    setPreference,
    unsubscribe,
} from '../../domain/notifications/inbox';
import { notificationRoutes, UNSUBSCRIBE_MOUNT } from '../../shared/api/notification-routes';
import type { DashboardDeps } from '../deps';
import type { RouteBinder } from './bind-route';

type NotificationRouteDeps = Pick<
    DashboardDeps,
    'notificationStore' | 'engines' | 'teams' | 'clock' | 'unsubscribeTokens' | 'logger'
> & { readonly routes: RouteBinder };

function inboxDeps(deps: NotificationRouteDeps) {
    return { store: deps.notificationStore, engines: deps.engines, teams: deps.teams, clock: deps.clock };
}

/** The bell and the preferences (D-41): the session user's own rows in the active organization, nothing else. */
export function bindNotificationRoutes(router: Hono, mount: string, deps: NotificationRouteDeps): void {
    const bind = deps.routes.bind.bind(deps.routes);
    const inbox = inboxDeps(deps);
    bind(router, mount, notificationRoutes.listNotifications, async ({ session }) => {
        const { items, otherOrgsWithUnseen } = await readInbox(inbox, session.actor);
        return {
            kind: 'ok',
            body: {
                notifications: items.map((item) => ({ ...item, project: item.project && { ...item.project } })),
                otherOrgsWithUnseen: [...otherOrgsWithUnseen],
            },
        };
    });
    bind(router, mount, notificationRoutes.markNotificationsSeen, async ({ input, session }) => {
        await markInboxSeen(
            inbox,
            session.actor,
            input.body.ids.map((id) => notificationIdSchema.parse(id)),
        );
        return { kind: 'ok', body: undefined, status: 204 };
    });
    bind(router, mount, notificationRoutes.listNotificationPreferences, async ({ session }) => ({
        kind: 'ok',
        body: { preferences: [...(await readPreferences(inbox, session.actor))] },
    }));
    bind(router, mount, notificationRoutes.setNotificationPreference, async ({ input, session }) => ({
        kind: 'ok',
        body: {
            preferences: [...(await setPreference(inbox, session.actor, input.params.kind, input.body.channel))],
        },
    }));
}

/**
 * The one-click unsubscribe (RFC 8058), outside `/api`: mail providers post it from their own servers, so the API's
 * same-origin guard would refuse them. The signed token is the whole authority, and all it can do is turn email off.
 */
export function createEmailRouter(deps: NotificationRouteDeps): Hono {
    const router = new Hono();
    deps.routes.bind(router, UNSUBSCRIBE_MOUNT, notificationRoutes.unsubscribe, async ({ input }) => {
        const claims = await deps.unsubscribeTokens.verify(input.query.token);
        if (claims === null) {
            return { kind: 'problem', status: 400, code: 'invalid-token' };
        }
        await unsubscribe(inboxDeps(deps), claims);
        deps.logger.info('notifications.unsubscribed', { kinds: claims.kinds.length });
        return { kind: 'ok', body: undefined, status: 204 };
    });
    return router;
}
