import type { InMemorySeed, InMemorySeedTask } from '@ptbk/engine-api/in-memory';

type SeedRun = NonNullable<InMemorySeed['runs']>[number];
type SeedTask = InMemorySeedTask['task'];
type SeedOccurrence = NonNullable<InMemorySeedTask['occurrences']>[number];
type SeedLink = NonNullable<InMemorySeedTask['links']>[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface TaskRunPlan {
    readonly agentId: string;
    /** Recurring work runs on its schedule; the rest was asked for by the owner. */
    readonly recurring: boolean;
    readonly queuedAtMs: number;
    readonly status: 'completed' | 'failed';
    readonly preview: string;
}

export interface TaskSeedInput {
    readonly epochMs: number;
    /** Live agents, in seed order; tasks go to the first three. */
    readonly agentIds: readonly string[];
    /** Member chats with a title; the first two become task conversations. */
    readonly chats: readonly { readonly id: string; readonly title: string }[];
    /** Builds a run of the seed's kind (steps, tool calls, usage) that ends before the epoch. */
    readonly buildRun: (plan: TaskRunPlan) => SeedRun;
}

export interface TaskSeed {
    readonly tasks: InMemorySeedTask[];
    /** Runs of task occurrences, already linked to their task and occurrence. */
    readonly runs: SeedRun[];
}

/** `2026-10-28 14:10:00`: the creation time every engine-generated task name carries. */
function stamp(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function iso(ms: number): string {
    return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * A small project as the engine models it: a parent with children, a dependency chain with a blocked task, a
 * recurring task with a failed occurrence and its retry, a reopened task, cancelled and retired work, goal-driven work
 * waiting for Router, and the engine's pending self-update. Every task the seed creates and every occurrence that ran
 * gets a real run linked to it.
 */
export function seedTasks(input: TaskSeedInput): TaskSeed {
    const [lead, writer, analyst] = [0, 1, 2].map((index) => input.agentIds[index % input.agentIds.length]);
    if (lead === undefined || writer === undefined || analyst === undefined) return { tasks: [], runs: [] };
    const epoch = input.epochMs;
    const runs: SeedRun[] = [];
    const definitions: SeedTask[] = [];
    const extras = new Map<string, Omit<InMemorySeedTask, 'task'>>();
    const extend = (task: SeedTask, extra: Omit<InMemorySeedTask, 'task'>) => extras.set(task.id, extra);
    const [planning, launchChat] = input.chats;

    const chatLink = (chat: { readonly id: string; readonly title: string } | undefined): SeedLink[] =>
        chat === undefined
            ? []
            : [
                  { direction: 'outgoing', target: { type: 'chat', chatId: chat.id, name: chat.title } },
                  { direction: 'incoming', target: { type: 'chat', chatId: chat.id, name: chat.title } },
              ];
    const fromChat = (chat: { readonly id: string; readonly title: string } | undefined, text: string) =>
        chat === undefined
            ? ({ kind: 'user', chatId: null, taskId: null, text } as const)
            : ({ kind: 'chat', chatId: chat.id, taskId: null, text: `Chat {${chat.title}}` } as const);

    function add(id: string, title: string, createdAtMs: number, fields: Partial<SeedTask>): SeedTask {
        const name = fields.kind === 'engine' ? title : `${title} — ${stamp(createdAtMs)}`;
        const task: SeedTask = {
            id,
            name,
            kind: 'ordinary',
            purpose: 'content',
            core: false,
            agentId: null,
            executor: null,
            priority: { rank: 0, text: null },
            state: 'ready',
            stateReason: null,
            next: null,
            conditions: [],
            repeat: null,
            notBefore: null,
            dueAt: null,
            nextAt: null,
            progress: null,
            parent: null,
            dependsOn: [],
            origin: null,
            doneCount: 0,
            lastDoneAt: null,
            reopened: false,
            sourcePath: fields.kind === 'engine' ? null : `tasks/${id.replace(/^task-/, '')}.book`,
            allowedActions: [],
            updatedAt: iso(createdAtMs),
            ...fields,
        };
        definitions.push(task);
        return task;
    }

    /** One occurrence, with a run when it started; the run carries the task's name as what started it. */
    function occurrence(
        task: SeedTask,
        sequence: number,
        fields: Omit<SeedOccurrence, 'id' | 'taskId' | 'sequence' | 'runIds'>,
    ): SeedOccurrence {
        const id = `occ-${task.id.replace(/^task-/, '')}-${String(sequence)}`;
        const agentId = task.agentId;
        // A seeded running run would be finished by the run simulator while its task stayed active, so only finished
        // occurrences get one.
        const runStatus = fields.state === 'completed' || fields.state === 'failed' ? fields.state : undefined;
        if (agentId !== null && fields.startedAt !== null && runStatus !== undefined) {
            const run = input.buildRun({
                agentId,
                recurring: task.repeat !== null,
                queuedAtMs: Date.parse(fields.startedAt),
                status: runStatus,
                preview: task.name,
            });
            runs.push({ ...run, taskId: task.id, occurrenceId: id });
            return {
                ...fields,
                id,
                taskId: task.id,
                sequence,
                runIds: [run.id],
                startedAt: run.startedAt,
                endedAt: run.completedAt,
            };
        }
        return { ...fields, id, taskId: task.id, sequence, runIds: [] };
    }

    const launchAt = epoch - 8 * DAY;
    const launch = add('task-launch-newsletter', 'Launch the customer newsletter', launchAt, {
        agentId: lead,
        state: 'active',
        stateReason: 'Running now.',
        priority: { rank: 2, text: 'high' },
        progress: { completed: 2, total: 4, summary: 'Coordinating the legal review before sending' },
        dueAt: iso(epoch + 6 * DAY),
        origin: fromChat(planning, 'Asked in chat'),
    });
    extend(launch, {
        links: chatLink(planning),
        notes: ['The first issue goes to existing customers only.'],
        occurrences: [
            occurrence(launch, 1, {
                cycle: 1,
                reason: 'first',
                retryOf: null,
                state: 'running',
                scheduledFor: null,
                startedAt: iso(epoch - 20 * MINUTE),
                endedAt: null,
                summary: null,
            }),
        ],
    });
    const parent = { taskId: launch.id, name: launch.name };

    const draft = add('task-draft-first-issue', 'Draft the first newsletter issue', launchAt + 2 * MINUTE, {
        agentId: writer,
        parent,
        state: 'done',
        stateReason: 'Completed.',
        doneCount: 1,
        lastDoneAt: iso(epoch - 6 * DAY),
        origin: { kind: 'task', chatId: null, taskId: launch.id, text: `Task {${launch.name}}` },
    });
    extend(draft, {
        occurrences: [
            occurrence(draft, 1, {
                cycle: 1,
                reason: 'first',
                retryOf: null,
                state: 'completed',
                scheduledFor: null,
                startedAt: iso(epoch - 6 * DAY - HOUR),
                endedAt: iso(epoch - 6 * DAY),
                summary: 'Draft saved as newsletter/issue-1.md.',
            }),
        ],
    });

    const review = add('task-legal-review', 'Review the draft with legal', launchAt + 3 * MINUTE, {
        agentId: lead,
        parent,
        state: 'awaiting-user',
        stateReason: 'Asked you in chat whether the discount wording is approved.',
        dependsOn: [{ taskId: draft.id, name: draft.name, state: 'met' }],
        conditions: [
            { kind: 'dependency', met: true, text: `${draft.name} is done` },
            { kind: 'answer', met: false, text: 'Your answer about the discount wording' },
        ],
        origin: { kind: 'task', chatId: null, taskId: launch.id, text: `Task {${launch.name}}` },
    });
    extend(review, { links: chatLink(launchChat) });

    add('task-send-first-issue', 'Send the first issue', launchAt + 4 * MINUTE, {
        agentId: writer,
        parent,
        priority: { rank: 2, text: null },
        state: 'waiting-dependency',
        stateReason: `Waits for ${review.name}.`,
        dependsOn: [
            { taskId: draft.id, name: draft.name, state: 'met' },
            { taskId: review.id, name: review.name, state: 'pending' },
        ],
        conditions: [
            { kind: 'dependency', met: true, text: `${draft.name} is done` },
            { kind: 'dependency', met: false, text: `${review.name} is done` },
            { kind: 'not-before', met: false, text: 'Not before Monday 09:00' },
        ],
        notBefore: iso(epoch + 4 * DAY),
        dueAt: iso(epoch + 6 * DAY),
        nextAt: iso(epoch + 4 * DAY),
        origin: { kind: 'task', chatId: null, taskId: launch.id, text: `Task {${launch.name}}` },
    });

    add('task-import-subscribers', 'Import the subscriber list', launchAt + 5 * MINUTE, {
        agentId: analyst,
        parent,
        state: 'blocked',
        stateReason: 'Dependency {Export contacts from the old CRM} was not found.',
        next: 'Fix the TASK DEPENDS ON reference (dependencies name tasks).',
        dependsOn: [{ taskId: null, name: 'Export contacts from the old CRM', state: 'missing' }],
        conditions: [{ kind: 'dependency', met: false, text: 'Export contacts from the old CRM is done' }],
        origin: { kind: 'task', chatId: null, taskId: launch.id, text: `Task {${launch.name}}` },
    });

    const digestAt = epoch - 13 * DAY;
    const slot = (week: number) => digestAt + week * 7 * DAY;
    const digest = add('task-weekly-digest', 'Weekly analytics digest', digestAt, {
        agentId: analyst,
        state: 'waiting-until',
        stateReason: 'Next occurrence in a day.',
        repeat: { text: '7d', intervalSeconds: 7 * 24 * 3600 },
        notBefore: iso(digestAt),
        nextAt: iso(slot(2)),
        priority: { rank: 1, text: null },
        doneCount: 2,
        lastDoneAt: iso(slot(1) + 2 * HOUR),
        origin: { kind: 'user', chatId: null, taskId: null, text: 'Added by the owner' },
    });
    extend(digest, {
        occurrences: [
            occurrence(digest, 1, {
                cycle: 1,
                reason: 'first',
                retryOf: null,
                state: 'completed',
                scheduledFor: iso(slot(0)),
                startedAt: iso(slot(0) + MINUTE),
                endedAt: iso(slot(0) + 12 * MINUTE),
                summary: 'Digest sent to the team channel.',
            }),
            occurrence(digest, 2, {
                cycle: 2,
                reason: 'repeat',
                retryOf: null,
                state: 'failed',
                scheduledFor: iso(slot(1)),
                startedAt: iso(slot(1) + MINUTE),
                endedAt: iso(slot(1) + 4 * MINUTE),
                summary: 'The analytics API answered 503.',
            }),
            occurrence(digest, 3, {
                cycle: 2,
                reason: 'retry',
                retryOf: `occ-weekly-digest-2`,
                state: 'completed',
                scheduledFor: iso(slot(1) + HOUR),
                startedAt: iso(slot(1) + HOUR),
                endedAt: iso(slot(1) + HOUR + 15 * MINUTE),
                summary: 'Digest sent to the team channel.',
            }),
            occurrence(digest, 4, {
                cycle: 3,
                reason: 'repeat',
                retryOf: null,
                state: 'pending',
                scheduledFor: iso(slot(2)),
                startedAt: null,
                endedAt: null,
                summary: null,
            }),
        ],
    });

    const typoAt = epoch - 12 * DAY;
    const typo = add('task-pricing-typo', 'Fix the typo on the pricing page', typoAt, {
        agentId: writer,
        state: 'ready',
        stateReason: 'Ready to start.',
        reopened: true,
        doneCount: 1,
        lastDoneAt: iso(typoAt + 2 * HOUR),
        origin: fromChat(launchChat, 'Asked in chat'),
    });
    extend(typo, {
        links: chatLink(launchChat),
        notes: ['Reopened: the Czech version of the page still has the typo.'],
        occurrences: [
            occurrence(typo, 1, {
                cycle: 1,
                reason: 'first',
                retryOf: null,
                state: 'completed',
                scheduledFor: null,
                startedAt: iso(typoAt + HOUR),
                endedAt: iso(typoAt + 2 * HOUR),
                summary: 'Fixed "anual" in the English page.',
            }),
            occurrence(typo, 2, {
                cycle: 2,
                reason: 'reopen',
                retryOf: null,
                state: 'pending',
                scheduledFor: null,
                startedAt: null,
                endedAt: null,
                summary: null,
            }),
        ],
    });

    add('task-german-blog', 'Translate the blog into German', epoch - 20 * DAY, {
        agentId: writer,
        state: 'cancelled',
        stateReason: 'Cancelled: German readers are not a target this quarter.',
        origin: { kind: 'user', chatId: null, taskId: null, text: 'Added by the owner' },
    });

    add('task-competitor-scan', 'Daily competitor price scan', epoch - 40 * DAY, {
        agentId: analyst,
        state: 'retired',
        stateReason: 'Recurring work retired.',
        repeat: { text: '1d', intervalSeconds: 24 * 3600 },
        doneCount: 18,
        lastDoneAt: iso(epoch - 22 * DAY),
        origin: { kind: 'user', chatId: null, taskId: null, text: 'Added by the owner' },
    });

    add('task-article-ideas', 'Suggest three article topics from customer questions', epoch - 2 * HOUR, {
        state: 'needs-assignment',
        stateReason: 'Router chooses the agent.',
        purpose: null,
        origin: { kind: 'goal', chatId: null, taskId: null, text: 'Goal discovery' },
    });

    add('task-engine-update', 'Update Promptbook 0.119.0 → 0.120.0', epoch - 3 * HOUR, {
        kind: 'engine',
        purpose: 'system',
        executor: 'Promptbook engine (deterministic update, no agent)',
        state: 'not-ready',
        stateReason: 'Waits until the installation is idle.',
        conditions: [{ kind: 'resource', met: false, text: 'No task is running' }],
        origin: { kind: 'engine', chatId: null, taskId: null, text: 'Automatic update' },
    });

    return { tasks: definitions.map((task) => ({ task, ...extras.get(task.id) })), runs };
}
