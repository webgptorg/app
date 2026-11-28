import { m } from '../../../paraglide/messages';
import { DAY_MS, definePlatformKind, type NotificationItem, type NotificationPlace } from '../notification-kind';

/** The status Durable Object's three moments (D-05, D-12). */
export type ProjectStatusEvent =
    | { readonly kind: 'online'; readonly at: number }
    | { readonly kind: 'offline'; readonly lastSeenAt: number }
    | { readonly kind: 'back-online' };

type Variant = 'online' | 'offline' | 'back-online';

function label(place: NotificationPlace): string {
    return place.project?.label ?? '';
}

/**
 * Offline, online for the first time, back online. The offline alert's threshold already waited, so its email goes on
 * the next run; back online is good news only for whoever heard the bad news, so it re-arms only an emailed outage.
 */
export const projectStatusKind = definePlatformKind<'project-status', ProjectStatusEvent, Variant>({
    id: 'project-status',
    source: 'platform',
    reach: 'viewers',
    variants: ['online', 'offline', 'back-online'],
    defaults: { 'org-owner': 'email', 'org-admin': 'email', 'team-admin': 'email', member: 'in-app' },
    timing: {
        emailDelayMs: 0,
        hourlyCap: false,
        closesWhenSeen: (variant) => variant !== 'offline',
        lifetimeMs: 30 * DAY_MS,
    },
    audience: () => ({ kind: 'project-viewers' }),
    reduce(row, event) {
        switch (event.kind) {
            case 'online':
                return row === null
                    ? { op: 'put', count: 1, variant: 'online', openedAt: event.at, rearm: true }
                    : { op: 'keep' };
            case 'offline':
                return { op: 'put', count: 1, variant: 'offline', openedAt: event.lastSeenAt, rearm: true };
            case 'back-online':
                if (row?.variant !== 'offline') {
                    return { op: 'keep' };
                }
                return row.emailedAt === null
                    ? { op: 'close' }
                    : { op: 'put', count: 1, variant: 'back-online', openedAt: row.openedAt, rearm: true };
        }
    },
    copy: {
        label: () => m.notification_project_status_label(),
        line(item: NotificationItem<Variant>, place, { locale, time }) {
            const project = label(place);
            switch (item.variant) {
                case 'offline':
                    return m.notification_project_offline_line({ project, since: time(item.openedAt) }, { locale });
                case 'back-online':
                    return m.notification_project_back_online_line({ project }, { locale });
                case 'online':
                case null:
                    return m.notification_project_online_line({ project }, { locale });
            }
        },
        subject(item, place, { locale }) {
            const project = label(place);
            switch (item.variant) {
                case 'offline':
                    return m.notification_project_offline_subject({ project }, { locale });
                case 'back-online':
                    return m.notification_project_back_online_subject({ project }, { locale });
                case 'online':
                case null:
                    return m.notification_project_online_subject({ project }, { locale });
            }
        },
        detail(item, _place, { locale, time, duration }) {
            switch (item.variant) {
                case 'offline':
                    return m.notification_project_offline_detail({ since: time(item.openedAt) }, { locale });
                case 'back-online':
                    return m.notification_project_back_online_detail(
                        {
                            duration: duration(item.updatedAt - item.openedAt),
                            since: time(item.openedAt),
                            back: time(item.updatedAt),
                        },
                        { locale },
                    );
                case 'online':
                case null:
                    return m.notification_project_online_detail({}, { locale });
            }
        },
        link: () => ({ to: 'project-page' }),
    },
});
