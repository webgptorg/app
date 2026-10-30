import type { AgentId } from '@ptbk/engine-api';
import { buttonClassName, Menu } from '@ptbk/ui';
import { CalendarPlus, ChevronDown, FolderGit2, Plus, Server } from 'lucide-react';
import { useState } from 'react';

import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import type { CreatableKind } from './integration-form';
import { LazyIntegrationFormDialog } from './lazy-integration-form-dialog';
import { useIntegrationMutations } from './use-integration-mutations';

/**
 * One "Add integration" menu for members with `integrations.manage`. Calendars connect through an OAuth flow the
 * engine runs on its own origin, and that contract route is still `draft`, so the calendar item stays disabled with the
 * reason as its description; no provider page or script is ever opened from here.
 */
export function AddIntegrationActions({ agentId }: { readonly agentId?: AgentId }) {
    const { can } = usePermissions();
    const mutations = useIntegrationMutations();
    const [adding, setAdding] = useState<CreatableKind | null>(null);
    if (!can('integrations.manage')) return null;
    return (
        <>
            <Menu
                label={m.integrations_add()}
                align="end"
                items={[
                    {
                        kind: 'item',
                        id: 'mcp-server',
                        label: m.integration_kind_mcp_server(),
                        icon: <Server aria-hidden />,
                        onSelect: () => {
                            setAdding('mcp-server');
                        },
                    },
                    {
                        kind: 'item',
                        id: 'repository',
                        label: m.integration_kind_repository(),
                        icon: <FolderGit2 aria-hidden />,
                        onSelect: () => {
                            setAdding('repository');
                        },
                    },
                    {
                        kind: 'item',
                        id: 'calendar',
                        label: m.integration_kind_calendar(),
                        description: m.integrations_connect_calendar_unavailable(),
                        icon: <CalendarPlus aria-hidden />,
                        disabled: true,
                        onSelect: () => undefined,
                    },
                ]}
                trigger={(props) => (
                    <button {...props} type="button" className={buttonClassName('primary', 'md')}>
                        <Plus aria-hidden className="size-4" />
                        {m.integrations_add()}
                        <ChevronDown aria-hidden className="size-4" />
                    </button>
                )}
            />
            {adding === null ? null : (
                <LazyIntegrationFormDialog
                    mode={{ kind: 'create', integrationKind: adding, ...(agentId === undefined ? {} : { agentId }) }}
                    mutations={mutations}
                    onClose={() => {
                        setAdding(null);
                    }}
                />
            )}
        </>
    );
}
