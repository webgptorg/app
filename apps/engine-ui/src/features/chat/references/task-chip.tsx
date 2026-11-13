import { useHovercard } from '@ptbk/ui';
import { ListTodo } from 'lucide-react';

import { cx } from '../../../app/cx';
import { CHAT_TASK_TINT_CLASSES, chatTaskTone } from './task-status';
import { TaskHovercard } from './task-hovercard';
import { useThreadReferences } from './thread-references';

const CHIP =
    'inline rounded-small bg-[color-mix(in_oklab,var(--tint)_10%,var(--color-sunken))] px-1 py-px font-medium text-text [box-decoration-break:clone] [overflow-wrap:anywhere]';

export interface TaskChipProps {
    /** The task's Book name, as `{name}` and `Chat.tasks` carry it. */
    readonly name: string;
    /** `false` inside another card: a quiet chip with no hovercard of its own. */
    readonly interactive?: boolean;
    readonly className?: string;
}

/**
 * A task by name: a task glyph on a neutral surface tinted by its state, so it never reads as an agent. In a thread
 * it opens the task's hovercard on hover, focus or click. The name is a text node only.
 */
export function TaskChip({ name, interactive = true, className }: TaskChipProps) {
    const references = useThreadReferences();
    const task = references?.tasks.get(name);
    const tone = task === undefined ? 'quiet' : chatTaskTone(task.state);
    const card = useHovercard({
        label: name,
        content:
            task === undefined || references === null ? null : (
                <TaskHovercard task={task} canOpen={references.canOpenTasks} />
            ),
    });
    const content = (
        <>
            <ListTodo aria-hidden className="me-1 inline size-3.5 align-[-0.15em] text-text-muted" />
            {name}
        </>
    );
    if (task === undefined || !interactive) {
        return <span className={cx(CHIP, CHAT_TASK_TINT_CLASSES[tone], className)}>{content}</span>;
    }
    return (
        <>
            <button
                type="button"
                {...card.triggerProps}
                onClick={(event) => {
                    if (card.open) card.hide();
                    else card.show(event.currentTarget);
                }}
                className={cx(
                    CHIP,
                    CHAT_TASK_TINT_CLASSES[tone],
                    'cursor-pointer text-start hover:bg-[color-mix(in_oklab,var(--tint)_18%,var(--color-sunken))] motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                    className,
                )}
            >
                {content}
            </button>
            {card.card}
        </>
    );
}
