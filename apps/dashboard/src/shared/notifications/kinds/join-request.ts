import { m } from '../../../paraglide/messages';
import { countUp, DAY_MS, definePlatformKind, UNSEEN_EMAIL_DELAY_MS } from '../notification-kind';

/**
 * People the dashboard sent to the project with an access ticket now wait for approval there, or the engine answered
 * some of them (ADR 0018). Requests through the engine's own invite links are the engine's to show.
 */
export type JoinRequestEvent =
    { readonly kind: 'waiting'; readonly requests: number } | { readonly kind: 'answered'; readonly requests: number };

/** The engine keeps a request for 7 days. */
const REQUEST_LIFETIME_MS = 7 * DAY_MS;

export const joinRequestKind = definePlatformKind<'join-request', JoinRequestEvent>({
    id: 'join-request',
    source: 'platform',
    reach: 'managers',
    variants: [],
    defaults: { 'org-owner': 'email', 'org-admin': 'email', 'team-admin': 'email', member: 'off' },
    timing: {
        emailDelayMs: UNSEEN_EMAIL_DELAY_MS,
        hourlyCap: true,
        closesWhenSeen: () => false,
        lifetimeMs: REQUEST_LIFETIME_MS,
    },
    // Only people with access can approve, so only the project's managers hear of it (ADR 0027, "Mapping").
    audience: () => ({ kind: 'project-managers' }),
    reduce(row, event, now) {
        switch (event.kind) {
            case 'waiting':
                return countUp(row, event.requests, null, now);
            case 'answered': {
                if (row === null) {
                    return { op: 'keep' };
                }
                const count = row.count - event.requests;
                return count <= 0
                    ? { op: 'close' }
                    : { op: 'put', count, variant: null, openedAt: row.openedAt, rearm: false };
            }
        }
    },
    copy: {
        label: () => m.notification_join_request_label(),
        line: (item, place, { locale }) =>
            m.notification_join_request_line({ count: item.count, project: place.project?.label ?? '' }, { locale }),
        subject: (item, place, { locale }) =>
            m.notification_join_request_subject({ count: item.count, project: place.project?.label ?? '' }, { locale }),
        detail: (_item, _place, { locale }, extras) =>
            extras.requesters.length === 0
                ? m.notification_join_request_detail_unnamed({}, { locale })
                : m.notification_join_request_detail(
                      { requesters: new Intl.ListFormat(locale, { type: 'conjunction' }).format(extras.requesters) },
                      { locale },
                  ),
        link: () => ({ to: 'project', path: '/members' }),
    },
});
