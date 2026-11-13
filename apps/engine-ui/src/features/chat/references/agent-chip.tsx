import { useHovercard } from '@ptbk/ui';

import { cx } from '../../../app/cx';
import { tintStyle } from './agent-color';
import { AgentHovercard } from './agent-hovercard';
import { useReferenceAgent, useThreadReferences } from './thread-references';

const CHIP =
    'inline rounded-small bg-[color-mix(in_oklab,var(--tint)_12%,transparent)] px-1 py-px font-medium text-tint [box-decoration-break:clone] [overflow-wrap:anywhere]';

export interface AgentChipProps {
    /** The agent's participant key (its `AgentId`). */
    readonly agentKey: string;
    /** Shown until the thread knows the agent; the thread's own name for it wins. */
    readonly name: string;
    /** `false` inside another card: a quiet chip with no hovercard and no action of its own. */
    readonly interactive?: boolean;
    readonly className?: string;
}

/**
 * `@Name` in the agent's colour. In a thread, hovering or focusing it shows who the agent is and what it is doing;
 * clicking it addresses the agent in the composer. The name is a text node, never markup or a link.
 */
export function AgentChip({ agentKey, name, interactive = true, className }: AgentChipProps) {
    const references = useThreadReferences();
    const agent = useReferenceAgent(agentKey, name);
    const label = `@${agent.name}`;
    const onMention = references?.onMention;
    const mention =
        onMention === undefined
            ? undefined
            : () => {
                  onMention(agent);
              };
    const card = useHovercard({
        label: agent.name,
        content:
            references === null ? null : <AgentHovercard agent={agent} references={references} onMention={mention} />,
    });
    if (references === null || !interactive) {
        return (
            <span className={cx(CHIP, className)} style={tintStyle(agent.color)}>
                {label}
            </span>
        );
    }
    return (
        <>
            <button
                type="button"
                {...card.triggerProps}
                onClick={(event) => {
                    if (mention === undefined) card.show(event.currentTarget);
                    else {
                        card.hide();
                        mention();
                    }
                }}
                className={cx(
                    CHIP,
                    'cursor-pointer text-start hover:bg-[color-mix(in_oklab,var(--tint)_20%,transparent)] motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                    className,
                )}
                style={tintStyle(agent.color)}
            >
                {label}
            </button>
            {card.card}
        </>
    );
}
