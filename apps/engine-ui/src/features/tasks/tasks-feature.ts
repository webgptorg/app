import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { ListTodo } from 'lucide-react';

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
    eventSync: { useEventSync: useTaskEventSync },
});
