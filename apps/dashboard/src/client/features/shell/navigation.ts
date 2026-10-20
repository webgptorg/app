import type { LinkProps } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { House, ShieldCheck, UserRound } from 'lucide-react';

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
}

/** The shell's navigation; later screens (engines D-06, billing D-07, admin tools) add their entries here. */
export const NAV_ENTRIES: readonly NavEntry[] = [
    { id: 'home', to: '/', label: () => m.nav_home(), icon: House, requires: { permission: 'org.read' } },
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
    return NAV_ENTRIES.filter((entry) => isAllowed(entry.requires, session));
}
