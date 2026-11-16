import type { AgentProfile } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { agentListQueryOptions } from '../agents/agents-queries';

/** The query `useOpenChatter` makes too: the engine's core agent named Chatter. */
const CHATTER_PARAMS = { origin: 'core', q: 'Chatter', limit: 10 } as const;

/**
 * How Chatter looks, so setup reads as Chatter asking: its picture and colour once the engine lists it, else the hue
 * its name hashes to. Without `agents.read` it stays the hashed hue and asks nothing.
 */
export function useChatterLook(): {
    readonly key: string;
    readonly profile: Pick<AgentProfile, 'avatarUrl' | 'color'>;
} {
    const allowed = useAllows({ permission: 'agents.read' });
    const found = useQuery({ ...agentListQueryOptions(useEngineApi(), CHATTER_PARAMS), enabled: allowed });
    const chatter = found.data?.items.find(({ name }) => name === 'Chatter');
    return {
        key: chatter?.id ?? 'chatter',
        profile: { avatarUrl: chatter?.profile.avatarUrl ?? null, color: chatter?.profile.color ?? null },
    };
}
