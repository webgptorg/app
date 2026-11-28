import { m } from '../../../paraglide/messages';
import { METERS, type MeterId } from '../../metering';
import { countUp, DAY_MS, definePlatformKind, UNSEEN_EMAIL_DELAY_MS } from '../notification-kind';

/** A meter (ADR 0025) reached its quota when the dashboard was about to add to it; `blocked` when the plan refused. */
export interface PlanLimitEvent {
    readonly kind: 'reached';
    readonly meter: MeterId;
}

export const planLimitKind = definePlatformKind<'plan-limit', PlanLimitEvent, MeterId>({
    id: 'plan-limit',
    source: 'platform',
    reach: 'viewers',
    variants: METERS,
    // Team admins hear of it once ADR 0026 knows who started the blocked link; until then the managers do.
    defaults: { 'org-owner': 'email', 'org-admin': 'in-app', 'team-admin': 'in-app', member: 'off' },
    timing: {
        emailDelayMs: UNSEEN_EMAIL_DELAY_MS,
        hourlyCap: true,
        closesWhenSeen: () => true,
        lifetimeMs: 7 * DAY_MS,
    },
    audience: () => ({ kind: 'org-managers' }),
    reduce(row, event, now) {
        // Limits of different meters merged read as "the plan's limits", so the meter goes once they differ.
        const variant = row === null || row.variant === event.meter ? event.meter : null;
        return countUp(row, 1, variant, now);
    },
    copy: {
        label: () => m.notification_plan_limit_label(),
        line: (item, place, { locale }) =>
            m.notification_plan_limit_line(
                {
                    org: place.orgName ?? m.notification_org_unnamed({}, { locale }),
                    meter: item.variant ?? 'any',
                },
                { locale },
            ),
        subject: (item, place, { locale }) =>
            m.notification_plan_limit_line(
                {
                    org: place.orgName ?? m.notification_org_unnamed({}, { locale }),
                    meter: item.variant ?? 'any',
                },
                { locale },
            ),
        detail: (_item, _place, { locale }) => m.notification_plan_limit_detail({}, { locale }),
        link: () => ({ to: 'dashboard', path: '/billing' }),
    },
});
