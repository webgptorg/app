import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { ListTodo } from 'lucide-react';
import { lazy } from 'react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { useTaskEventSync } from './use-task-event-sync';

/**
 * Tasks (`tasks@1`): the engine's task inventory, read-only. Runs stay the run history: a run is one attempt at an
 * occurrence (or a chat reply, which is no task), so each occurrence links its runs and each run its task.
 */
export const tasksFeature = defineFeature({
    id: 'tasks',
    requires: { capability: KNOWN_CAPABILITIES.tasks, permission: 'tasks.read' },
    nav: { group: 'work', order: 30, label: m.nav_tasks, icon: ListTodo, to: '/tasks' },
    // Lazy, so the section's code loads with the agent page that shows it; the overview suspends around it.
    agentOverviewCards: [
        {
            id: 'tasks.agent',
            order: 6,
            component: lazy(() => import('./agent-tasks-card').then((module) => ({ default: module.AgentTasksCard }))),
        },
    ],
    eventSync: { useEventSync: useTaskEventSync },
});
