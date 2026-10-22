import { Menu } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChevronsUpDown } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { apiRoutes, type SessionView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, queryKeys } from '../../api/queries';
import { useAppMutation } from '../../core/mutations';
import { useSession } from '../session/use-session';

function orgName(org: { readonly name: string | null }): string {
    return org.name ?? m.org_personal();
}

/**
 * The organizations the person belongs to (one in v0). Switching moves the server-side session; every cached answer
 * belonged to the old organization, so all of it is dropped before the engine list loads again.
 */
export function OrgSwitcher() {
    const api = useApiClient();
    const session = useSession();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const active = session.activeOrg;
    const switchOrg = useAppMutation({
        mutationFn: async (orgId: string) => dataOrThrow(await api.call(apiRoutes.setActiveOrg, { body: { orgId } })),
        errorMessage: () => m.org_switch_failed(),
        onSuccess: async (next: SessionView) => {
            queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.session[0] });
            queryClient.setQueryData(queryKeys.session, next);
            await navigate({ to: '/engines' });
        },
    });
    const items: MenuEntry[] = session.memberships.map((membership) => ({
        kind: 'item',
        id: membership.orgId,
        label: orgName(membership),
        checkable: 'radio',
        checked: membership.orgId === active.id,
        onSelect: () => {
            if (membership.orgId !== active.id) {
                switchOrg.mutate(membership.orgId);
            }
        },
    }));
    const name = orgName(active);
    return (
        <Menu
            label={m.org_switcher()}
            items={items}
            trigger={(props) => (
                <button
                    {...props}
                    type="button"
                    aria-label={m.org_switcher_for({ name })}
                    className="flex min-w-0 cursor-pointer items-center gap-1 rounded-control px-1.5 py-1 text-sm font-medium hover:bg-hover motion-safe:transition-colors motion-safe:duration-(--motion-state)"
                >
                    <span className="truncate">{name}</span>
                    <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-text-muted" />
                </button>
            )}
        />
    );
}
