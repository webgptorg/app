import type { AgentId } from '@ptbk/engine-api';
import { Combobox, Field } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { AgentAvatar } from '../agents/agent-avatar';
import { agentListQueryOptions } from '../agents/agents-queries';
import { useAllows } from '../../app/registry/use-visible-features';

/** The first page of agents names the choices; an agent beyond it can still be reached from its own Files tab. */
export const AGENT_CHOICES = { sort: 'name', limit: 100 } as const;

/** The agent a file goes to, by name and face; absent without `agents.read`. */
export function AgentSelect({
    label,
    placeholder,
    value,
    onChange,
}: {
    readonly label: string;
    readonly placeholder: string;
    readonly value: AgentId | undefined;
    readonly onChange: (agentId: AgentId | undefined) => void;
}) {
    const allowed = useAllows({ permission: 'agents.read' });
    const agents = useQuery({ ...agentListQueryOptions(useEngineApi(), AGENT_CHOICES), enabled: allowed });
    if (!allowed) return null;
    const items = agents.data?.items ?? [];
    return (
        <Field label={label} required className="w-full sm:max-w-xs">
            {(control) => (
                <Combobox
                    {...control}
                    searchable={items.length > 7}
                    placeholder={placeholder}
                    value={value ?? null}
                    options={items.map((agent) => ({
                        value: agent.id,
                        label: agent.name,
                        leading: (
                            <AgentAvatar
                                name={agent.name}
                                agentKey={agent.id}
                                profile={agent.profile}
                                origin={agent.origin}
                                size="2xs"
                            />
                        ),
                    }))}
                    onChange={(chosen) => {
                        onChange(items.find((agent) => agent.id === chosen)?.id);
                    }}
                />
            )}
        </Field>
    );
}
