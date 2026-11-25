import { EntityChip } from '@ptbk/ui';

import { threadAgentHovercard } from './agent-hovercard';
import { useReferenceAgent, useThreadReferences } from './thread-references';

export interface AgentChipProps {
    /** The agent's participant key (its `AgentId`). */
    readonly agentKey: string;
    /** Shown until the thread knows the agent; the thread's own name for it wins. */
    readonly name: string;
    /** The mention as written (`@Copywritera`); `@` and the agent's name otherwise. */
    readonly label?: string;
    /** `false` inside another card: a quiet chip with no hovercard and no action of its own. */
    readonly interactive?: boolean;
    readonly className?: string;
}

/**
 * `@Name` in the agent's colour. In a thread, hovering or focusing it opens the agent's card, the same one as
 * everywhere, with what the agent does here; clicking it addresses the agent in the composer. The name is a text node,
 * never markup or a link.
 */
export function AgentChip({ agentKey, name, label: written, interactive = true, className }: AgentChipProps) {
    const references = useThreadReferences();
    const agent = useReferenceAgent(agentKey, name);
    const onMention = references?.onMention;
    const mention =
        onMention === undefined
            ? undefined
            : () => {
                  onMention(agent);
              };
    const hovercard =
        references === null || !references.canOpenAgents ? null : threadAgentHovercard(agent, references, mention);
    return (
        <EntityChip
            wrap
            tone="agent"
            label={written ?? `@${agent.name}`}
            tint={agent.color}
            interactive={interactive && (hovercard !== null || mention !== undefined)}
            hovercard={hovercard ?? undefined}
            onClick={(event, card) => {
                if (mention === undefined) card.show(event.currentTarget);
                else {
                    card.hide();
                    mention();
                }
            }}
            className={className}
        />
    );
}
