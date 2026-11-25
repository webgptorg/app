import { AGENT_VISIBILITIES, AgentVisibility, KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { Button, Combobox, Field, Section } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { BookOpen, Trash2 } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { AgentBookModelSettings } from '../book/agent-book-model-settings';
import { AGENT_TABS } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { useAllows } from '../../app/registry/use-visible-features';
import { useAgentActions } from './agent-actions';
import { VisibilityIcon, visibilityLabel } from './agent-badges';
import { useAgentIdParam } from './agent-detail-route';
import { useAgentTabs } from './agent-tabs';
import { AgentAvatar } from './agent-avatar';
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
    const mayWrite = useAllows({ permission: 'agents.write' });
    const canWriteBook = useAllows({ capability: KNOWN_CAPABILITIES.bookEditor, permission: 'agents.write' });
    const bookTab = useAgentTabs().find((tab) => tab.id === AGENT_TABS.book.id);
    const actions = useAgentActions({
        onDeleted: () => {
            void navigate({ to: '/agents' });
        },
    });

    return (
        // The tabs' line already separates the first section from the header.
        <div className="flex max-w-3xl flex-col gap-6 [&>*:first-child]:border-t-0 [&>*:first-child]:pt-1">
            <Section title={m.agent_settings_picture()}>
                <div className="flex flex-wrap items-center gap-5">
                    <AgentAvatar
                        name={agent.name}
                        agentKey={agent.id}
                        profile={agent.profile}
                        origin={agent.origin}
                        size="xl"
                    />
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
                        <p className="text-sm text-text-muted">
                            {agent.profile.avatarUrl !== null
                                ? m.agent_settings_picture_own()
                                : agent.profile.illustration === null
                                  ? m.agent_settings_picture_auto()
                                  : m.agent_settings_picture_chosen()}
                        </p>
                        {/* Choosing comes later (the contract already carries the choice); the place is shown now. */}
                        <Button size="sm" disabled aria-describedby="agent-picture-later">
                            {m.agent_settings_picture_change()}
                        </Button>
                        <p id="agent-picture-later" className="text-xs text-text-subtle">
                            {m.agent_settings_picture_later()}
                        </p>
                    </div>
                </div>
            </Section>
            {bookTab === undefined || !mayWrite || agent.origin === 'system' ? null : (
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
                            {canWriteBook ? m.agent_settings_identity_link() : m.agent_tab_book()}
                        </ButtonLink>
                    }
                />
            )}
            {agent.origin !== 'system' && <AgentBookModelSettings />}
            {agent.origin !== 'system' && actions.canChangeVisibility ? (
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
            {actions.canDelete(agent) ? (
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
