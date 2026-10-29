import { AGENT_VISIBILITIES, AgentVisibility } from '@ptbk/engine-api';
import { Button, Card, Field, Select } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { AGENT_TABS } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { useAgentActions } from './agent-actions';
import { visibilityLabel } from './agent-badges';
import { useAgentIdParam } from './agent-detail-route';
import { useAgentTabs } from './agent-tabs';
import { agentDetailQueryOptions } from './agents-queries';

function visibilityHint(visibility: AgentVisibility): string {
    switch (visibility) {
        case 'public':
            return m.agent_visibility_public_hint();
        case 'unlisted':
            return m.agent_visibility_unlisted_hint();
        case 'private':
            return m.agent_visibility_private_hint();
    }
}

/**
 * Visibility (`agents.write`) and delete (`agents.delete`); each section only for a member who may use it. The name
 * and description are not editable here: they are lines of the book, so this page points there.
 */
export function AgentSettings() {
    const agentId = useAgentIdParam();
    const { data: agent } = useSuspenseQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    const navigate = useNavigate();
    const canEditBook = usePermissions().can('agents.write');
    const bookTab = useAgentTabs().find((tab) => tab.id === AGENT_TABS.book.id);
    const actions = useAgentActions({
        onDeleted: () => {
            void navigate({ to: '/agents' });
        },
    });

    return (
        <div className="flex flex-col gap-6">
            {bookTab === undefined || !canEditBook ? null : (
                <Card title={m.agent_settings_identity()}>
                    <p className="max-w-prose text-sm text-text-muted">
                        {m.agent_settings_identity_body({ name: agent.name })}
                    </p>
                    <div>
                        <Link to={bookTab.to} params={{ agentId: agent.id } as never}>
                            {m.agent_settings_identity_link()}
                        </Link>
                    </div>
                </Card>
            )}
            {actions.canChangeVisibility ? (
                <Card title={m.agent_settings_visibility()}>
                    <Field
                        label={m.agents_column_visibility()}
                        hint={visibilityHint(agent.visibility)}
                        className="w-full sm:max-w-sm"
                    >
                        {(control) => (
                            <Select
                                {...control}
                                value={agent.visibility}
                                onChange={(event) => {
                                    const next = AgentVisibility.safeParse(event.target.value);
                                    if (next.success) actions.changeVisibility(agent, next.data);
                                }}
                            >
                                {AGENT_VISIBILITIES.map((visibility) => (
                                    <option key={visibility} value={visibility}>
                                        {visibilityLabel(visibility)}
                                    </option>
                                ))}
                            </Select>
                        )}
                    </Field>
                </Card>
            ) : null}
            {actions.canDelete ? (
                <Card title={m.agent_settings_danger()}>
                    <p className="max-w-prose text-sm text-text-muted">{m.agent_delete_body({ name: agent.name })}</p>
                    <div>
                        <Button
                            className="text-danger"
                            onClick={() => {
                                actions.requestDelete(agent);
                            }}
                        >
                            <Trash2 aria-hidden className="size-4" />
                            {m.agent_delete_named({ name: agent.name })}
                        </Button>
                    </div>
                </Card>
            ) : null}
            {actions.dialogs}
        </div>
    );
}
