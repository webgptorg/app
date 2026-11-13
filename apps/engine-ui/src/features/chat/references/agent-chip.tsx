import { EntityChip } from '@ptbk/ui';

import { AgentHovercard } from './agent-hovercard';
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
 * `@Name` in the agent's colour. In a thread, hovering or focusing it shows who the agent is and what it is doing;
 * clicking it addresses the agent in the composer. The name is a text node, never markup or a link.
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
    return (
        <EntityChip
            wrap
            tone="agent"
            label={written ?? `@${agent.name}`}
            tint={agent.color}
            interactive={references !== null && interactive}
            hovercard={
                references === null
                    ? undefined
                    : {
                          label: agent.name,
                          content: <AgentHovercard agent={agent} references={references} onMention={mention} />,
                      }
            }
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
