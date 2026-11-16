import { AGENT_VISIBILITIES, AgentVisibility } from '@ptbk/engine-api';
import { Button, Combobox, Field, Section } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { BookOpen, Trash2 } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { AGENT_TABS } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { useAgentActions } from './agent-actions';
import { VisibilityIcon, visibilityLabel } from './agent-badges';
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
        // The tabs' line already separates the first section from the header.
        <div className="flex max-w-3xl flex-col gap-6 [&>*:first-child]:border-t-0 [&>*:first-child]:pt-1">
            {bookTab === undefined || !canEditBook ? null : (
                <Section
                    title={m.agent_settings_identity()}
                    description={m.agent_settings_identity_body({ name: agent.name })}
                    actions={
                        <ButtonLink
                            to={bookTab.to}
                            params={{ agentId: agent.id } as never}
                            variant="secondary"
                            size="sm"
                        >
                            <BookOpen aria-hidden className="size-4" />
                            {m.agent_settings_identity_link()}
                        </ButtonLink>
                    }
                />
            )}
            {actions.canChangeVisibility ? (
                <Section title={m.agent_settings_visibility()}>
                    <Field
                        label={m.agents_column_visibility()}
                        hint={visibilityHint(agent.visibility)}
                        className="w-full sm:max-w-sm"
                    >
                        {(control) => (
                            <Combobox
                                {...control}
                                value={agent.visibility}
                                options={AGENT_VISIBILITIES.map((visibility) => ({
                                    value: visibility,
                                    label: visibilityLabel(visibility),
                                    description: visibilityHint(visibility),
                                    leading: <VisibilityIcon visibility={visibility} />,
                                }))}
                                onChange={(value) => {
                                    const next = AgentVisibility.safeParse(value);
                                    if (next.success) actions.changeVisibility(agent, next.data);
                                }}
                            />
                        )}
                    </Field>
                </Section>
            ) : null}
            {actions.canDelete ? (
                <Section
                    title={m.agent_settings_danger()}
                    description={m.agent_delete_body({ name: agent.name })}
                    actions={
                        <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                                actions.requestDelete(agent);
                            }}
                        >
                            <Trash2 aria-hidden className="size-4" />
                            {m.agent_delete_named({ name: agent.name })}
                        </Button>
                    }
                />
            ) : null}
            {actions.dialogs}
        </div>
    );
}
