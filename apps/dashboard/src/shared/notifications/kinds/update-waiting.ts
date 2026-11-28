import { m } from '../../../paraglide/messages';
import { DAY_MS, definePlatformKind, UNSEEN_EMAIL_DELAY_MS } from '../notification-kind';

/** The heartbeat's `update` turned `available` (the engine waits for someone), or left it. */
export type UpdateWaitingEvent = { readonly kind: 'waiting' } | { readonly kind: 'done' };

export const updateWaitingKind = definePlatformKind<'update-waiting', UpdateWaitingEvent>({
    id: 'update-waiting',
    source: 'platform',
    reach: 'viewers',
    variants: [],
    defaults: { 'org-owner': 'in-app', 'org-admin': 'in-app', 'team-admin': 'in-app', member: 'off' },
    timing: {
        emailDelayMs: UNSEEN_EMAIL_DELAY_MS,
        hourlyCap: true,
        closesWhenSeen: () => false,
        lifetimeMs: 30 * DAY_MS,
    },
    audience: () => ({ kind: 'project-viewers' }),
    reduce(row, event, now) {
        switch (event.kind) {
            case 'waiting':
                return row === null
                    ? { op: 'put', count: 1, variant: null, openedAt: now, rearm: true }
                    : { op: 'keep' };
            case 'done':
                return row === null ? { op: 'keep' } : { op: 'close' };
        }
    },
    copy: {
        label: () => m.notification_update_waiting_label(),
        line: (_item, place, { locale }) =>
            m.notification_update_waiting_line({ project: place.project?.label ?? '' }, { locale }),
        subject: (_item, place, { locale }) =>
            m.notification_update_waiting_subject({ project: place.project?.label ?? '' }, { locale }),
        link: () => ({ to: 'project', path: '/' }),
    },
});
