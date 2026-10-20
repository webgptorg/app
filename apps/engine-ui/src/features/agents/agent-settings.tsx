import { AGENT_VISIBILITIES, AgentVisibility } from '@ptbk/engine-api';
import { Button, Card, Field, Select } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { useAgentActions } from './agent-actions';
import { visibilityLabel } from './agent-badges';
import { useAgentIdParam } from './agent-detail-route';
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

/** Visibility (`agents.write`) and delete (`agents.delete`); each section only for a member who may use it. */
export function AgentSettings() {
    const agentId = useAgentIdParam();
    const { data: agent } = useSuspenseQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    const navigate = useNavigate();
    const actions = useAgentActions({
        onDeleted: () => {
            void navigate({ to: '/agents' });
        },
    });

    return (
        <div className="flex flex-col gap-6">
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
                    <p className="max-w-prose text-sm text-text-muted">{m.agent_delete_body()}</p>
                    <div>
                        <Button
                            variant="danger"
                            onClick={() => {
                                actions.requestDelete(agent);
                            }}
                        >
                            <Trash2 aria-hidden className="size-4" />
                            {m.agent_action_delete()}
                        </Button>
                    </div>
                </Card>
            ) : null}
            {actions.dialogs}
        </div>
    );
}
