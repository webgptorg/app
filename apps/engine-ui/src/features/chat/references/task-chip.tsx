import { EntityChip, STATUS_TINT_CLASSES } from '@ptbk/ui';
import { ListTodo } from 'lucide-react';

import { CHAT_TASK_STATUS_TONES, chatTaskTone } from './task-status';
import { TaskHovercard } from './task-hovercard';
import { useThreadReferences } from './thread-references';

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
    const tone = CHAT_TASK_STATUS_TONES[task === undefined ? 'quiet' : chatTaskTone(task.state)];
    return (
        <EntityChip
            wrap
            label={name}
            leading={<ListTodo />}
            tintClassName={STATUS_TINT_CLASSES[tone]}
            interactive={task !== undefined && interactive}
            hovercard={
                task === undefined || references === null
                    ? undefined
                    : { label: name, content: <TaskHovercard task={task} canOpen={references.canOpenTasks} /> }
            }
            className={className}
        />
    );
}
