import type { LinkProps } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { Contact, CreditCard, ShieldCheck, UserRound, UsersRound } from 'lucide-react';

import type { SessionView } from '../../../shared/api/routes';
import { m } from '../../../paraglide/messages';
import { isPlatformAdmin } from '../session/session-guards';

/**
 * What a navigation entry needs: a permission of the active org (`GET /api/session` lists the org-scoped ones), the
 * platform admin role (for `/admin`), or nothing for what every signed-in person has, such as their own account.
 */
export type NavRequirement = { readonly permission: string } | { readonly platformAdmin: true } | null;

export interface NavEntry {
    readonly id: string;
    readonly to: NonNullable<LinkProps['to']>;
    readonly label: () => string;
    readonly icon: ComponentType<{ readonly 'aria-hidden': true; readonly className?: string }>;
    readonly requires: NavRequirement;
    /** Shown only while the dashboard charges (`billingEnabled`). */
    readonly billingOnly?: true;
}

/** The shell's navigation; later screens (admin tools) add their entries here. */
export const NAV_ENTRIES: readonly NavEntry[] = [
    // Each entry is a team underneath (ADR 0018); the screens say engine until that design is settled.
    {
        id: 'engines',
        to: '/engines',
        label: () => m.nav_teams(),
        icon: UsersRound,
        requires: { permission: 'team.read' },
    },
    {
        id: 'people',
        to: '/people',
        label: () => m.nav_people(),
        icon: Contact,
        requires: { permission: 'org.members.read' },
    },
    {
        id: 'billing',
        to: '/billing',
        label: () => m.nav_billing(),
        icon: CreditCard,
        requires: { permission: 'billing.read' },
        billingOnly: true,
    },
    {
        id: 'account',
        to: '/account',
        label: () => m.nav_account(),
        icon: UserRound,
        requires: null,
    },
    { id: 'admin', to: '/admin', label: () => m.nav_admin(), icon: ShieldCheck, requires: { platformAdmin: true } },
];

export function isAllowed(requirement: NavRequirement, session: SessionView): boolean {
    if (requirement === null) {
        return true;
    }
    return 'permission' in requirement
        ? session.activeOrg.permissions.includes(requirement.permission)
        : isPlatformAdmin(session);
}

export function visibleNavEntries(session: SessionView): readonly NavEntry[] {
    return NAV_ENTRIES.filter(
        (entry) => isAllowed(entry.requires, session) && (entry.billingOnly !== true || session.billingEnabled),
    );
}
