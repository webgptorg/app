import type { AgentTabEntry } from '../../app/registry/feature';
import { useVisibleFeatures } from '../../app/registry/use-visible-features';

/** The agent detail tabs every visible feature registers, in their declared order. */
export function useAgentTabs(): readonly AgentTabEntry[] {
    return useVisibleFeatures()
        .flatMap((feature) => feature.agentTabs ?? [])
        .toSorted((a, b) => a.order - b.order);
}
