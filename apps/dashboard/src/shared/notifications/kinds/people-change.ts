import { m } from '../../../paraglide/messages';
import {
    countUp,
    DAY_MS,
    definePlatformKind,
    UNSEEN_EMAIL_DELAY_MS,
    type NotificationItem,
    type NotificationPlace,
    type RenderContext,
} from '../notification-kind';

/**
 * Changes to people: someone joined the organization (to its managers), and a person's own role or project access
 * changed (to them only). Who it was is not kept: merged repeats are counted, never listed.
 */
export type PeopleChangeEvent =
    | { readonly kind: 'joined' }
    | { readonly kind: 'role'; readonly userId: string }
    | { readonly kind: 'added'; readonly userId: string };

type Variant = PeopleChangeEvent['kind'];

function line(item: NotificationItem<Variant>, place: NotificationPlace, { locale }: RenderContext): string {
    const org = place.orgName ?? m.notification_org_unnamed({}, { locale });
    switch (item.variant) {
        case 'joined':
            return m.notification_people_joined_line({ count: item.count, org }, { locale });
        case 'role':
            return m.notification_people_role_line({ org }, { locale });
        case 'added':
            return m.notification_people_added_line({ project: place.project?.label ?? org }, { locale });
        case null:
            return m.notification_people_changes_line({ count: item.count, org }, { locale });
    }
}

export const peopleChangeKind = definePlatformKind<'people-change', PeopleChangeEvent, Variant>({
    id: 'people-change',
    source: 'platform',
    reach: 'viewers',
    variants: ['joined', 'role', 'added'],
    defaults: { 'org-owner': 'in-app', 'org-admin': 'in-app', 'team-admin': 'in-app', member: 'email' },
    timing: {
        emailDelayMs: UNSEEN_EMAIL_DELAY_MS,
        hourlyCap: true,
        closesWhenSeen: () => true,
        lifetimeMs: 7 * DAY_MS,
    },
    audience: (event) =>
        event.kind === 'joined' ? { kind: 'org-managers' } : { kind: 'person', userId: event.userId },
    reduce(row, event, now) {
        // Different changes merged into one row read as "3 changes", so the variant is dropped once they differ.
        const variant = row === null || row.variant === event.kind ? event.kind : null;
        return countUp(row, 1, variant, now);
    },
    copy: {
        label: () => m.notification_people_change_label(),
        line,
        subject: line,
        link: (item) =>
            item.variant === 'added'
                ? { to: 'project-page' }
                : { to: 'dashboard', path: item.variant === 'role' ? '/' : '/people' },
    },
});
