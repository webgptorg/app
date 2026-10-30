import type { AgentId } from '@ptbk/engine-api';
import { Button } from '@ptbk/ui';
import { CalendarPlus, FolderGit2, Plus } from 'lucide-react';
import { useState } from 'react';

import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import type { CreatableKind } from './integration-form';
import { LazyIntegrationFormDialog } from './lazy-integration-form-dialog';
import { useIntegrationMutations } from './use-integration-mutations';

/**
 * "Add MCP server" and "Add repository" for members with `integrations.manage`. Calendars connect through an OAuth
 * flow the engine runs on its own origin, and that contract route is still `draft`, so "Connect calendar" stays
 * disabled with the reason in its tooltip; no provider page or script is ever opened from here.
 */
export function AddIntegrationActions({ agentId }: { readonly agentId?: AgentId }) {
    const { can } = usePermissions();
    const mutations = useIntegrationMutations();
    const [adding, setAdding] = useState<CreatableKind | null>(null);
    if (!can('integrations.manage')) return null;
    return (
        <>
            <div className="flex flex-wrap gap-2">
                <Button
                    variant="primary"
                    onClick={() => {
                        setAdding('mcp-server');
                    }}
                >
                    <Plus aria-hidden className="size-4" />
                    {m.integrations_add_mcp()}
                </Button>
                <Button
                    onClick={() => {
                        setAdding('repository');
                    }}
                >
                    <FolderGit2 aria-hidden className="size-4" />
                    {m.integrations_add_repository()}
                </Button>
                <Button disabled disabledReason={m.integrations_connect_calendar_unavailable()}>
                    <CalendarPlus aria-hidden className="size-4" />
                    {m.integrations_connect_calendar()}
                </Button>
            </div>
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
