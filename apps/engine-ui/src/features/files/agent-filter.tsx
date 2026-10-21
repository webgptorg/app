import type { AgentId } from '@ptbk/engine-api';
import { Field, Select } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { agentListQueryOptions } from '../agents/agents-queries';
import { usePermissions } from '../session/use-permissions';

/** The first page of agents names the choices; an agent beyond it can still be filtered by from its own Files tab. */
const AGENT_CHOICES = 100;

/** Agents by name for a filter or a target; absent without `agents.read`. */
export function AgentSelect({
    label,
    allLabel,
    value,
    onChange,
    required = false,
}: {
    readonly label: string;
    readonly allLabel: string;
    readonly value: AgentId | undefined;
    readonly onChange: (agentId: AgentId | undefined) => void;
    readonly required?: boolean;
}) {
    const { can } = usePermissions();
    const agents = useQuery({
        ...agentListQueryOptions(useEngineApi(), { sort: 'name', limit: AGENT_CHOICES }),
        enabled: can('agents.read'),
    });
    if (!can('agents.read')) return null;
    const items = agents.data?.items ?? [];
    return (
        <Field label={label} required={required} className="w-full sm:max-w-xs">
            {(control) => (
                <Select
                    {...control}
                    value={value ?? ''}
                    onChange={(event) => {
                        const chosen = items.find((agent) => agent.id === event.target.value);
                        onChange(chosen?.id);
                    }}
                >
                    <option value="">{allLabel}</option>
                    {value !== undefined && !items.some((agent) => agent.id === value) ? (
                        <option value={value}>{value}</option>
                    ) : null}
                    {items.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                            {agent.name}
                        </option>
                    ))}
                </Select>
            )}
        </Field>
    );
}
