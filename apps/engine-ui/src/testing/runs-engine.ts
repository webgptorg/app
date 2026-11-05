import type { CapabilityRef, EngineApiClient, Permission } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineController, InMemorySeed, InMemorySeedRun } from '@ptbk/engine-api/in-memory';
import { vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { OWNER_ID } from './agents-engine';
import { TEST_NOW } from './test-engine-api';

/** Every way agent output tries to become markup, a script or a navigation. */
export const HOSTILE =
    '<img src=x onerror=alert(1)> <script>alert(1)</script> [x](javascript:alert(1)) javascript:alert(1)';

export const RUN_IDS = {
    completed: 'run-completed',
    failed: 'run-failed',
    running: 'run-running',
    queued: 'run-queued',
    cancelled: 'run-cancelled',
    largeDiff: 'run-large-diff',
} as const;

/** Lines in the diff that tests virtualisation. */
export const LARGE_DIFF_LINES = 20_000;
/** Older completed runs of Max, so the global list has a second page. */
export const FILLER_RUNS = 55;

const ago = (ms: number) => new Date(TEST_NOW.getTime() - ms).toISOString();
const MINUTE = 60_000;

function run(id: string, fields: Partial<InMemorySeedRun> & Pick<InMemorySeedRun, 'agentId'>): InMemorySeedRun {
    return {
        id,
        source: 'member',
        status: 'completed',
        chatId: null,
        messageId: null,
        triggerId: null,
        retryOf: null,
        createdBy: OWNER_ID,
        queuedAt: ago(60 * MINUTE),
        startedAt: ago(59 * MINUTE),
        completedAt: ago(50 * MINUTE),
        cancelRequestedAt: null,
        attemptCount: 1,
        runner: 'claude-code',
        model: 'claude-sonnet-4-5',
        progress: null,
        usage: null,
        error: null,
        preview: null,
        toolCalls: [],
        outputs: { messages: [], files: [], projectChanges: [] },
        report: { touchedProjects: [], externalSources: [] },
        ...fields,
    };
}

const SMALL_DIFF = [
    'diff --git a/src/billing.ts b/src/billing.ts',
    'index 1111111..2222222 100644',
    '--- a/src/billing.ts',
    '+++ b/src/billing.ts',
    '@@ -1,3 +1,3 @@',
    ' export function total(items: readonly number[]) {',
    '-    return items.reduce((a, b) => a + b);',
    '+    return items.reduce((a, b) => a + b, 0);',
    ' }',
    '',
].join('\n');

const HOSTILE_DIFF = ['--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '-Welcome', `+${HOSTILE}`, ''].join('\n');

function largeDiff(): string {
    const lines = ['--- a/data.csv', '+++ b/data.csv', `@@ -0,0 +1,${String(LARGE_DIFF_LINES - 3)} @@`];
    for (let index = lines.length; index < LARGE_DIFF_LINES; index++) lines.push(`+row ${String(index)}`);
    return `${lines.join('\n')}\n`;
}

/** Runs in every status across four agents, with the hostile samples, a 20,000-line diff and enough for two pages. */
export function runsSeed(): InMemorySeed {
    const filler = Array.from({ length: FILLER_RUNS }, (_, index) =>
        run(`run-old-${String(index + 1).padStart(3, '0')}`, {
            agentId: 'agent-max',
            source: index % 2 === 0 ? 'api' : 'goal',
            queuedAt: ago((3 + index) * 60 * MINUTE),
            startedAt: ago((3 + index) * 60 * MINUTE - MINUTE),
            completedAt: ago((3 + index) * 60 * MINUTE - 2 * MINUTE),
            preview: `Nightly import ${String(index + 1)}`,
        }),
    );
    return {
        engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
        agents: [
            { id: 'agent-ada', source: 'Ada\nPERSONA Research' },
            { id: 'agent-grace', source: 'Grace\nPERSONA Review' },
            { id: 'agent-iris', source: 'Iris\nPERSONA Reports' },
            { id: 'agent-max', source: 'Max\nPERSONA Imports' },
        ],
        chats: [
            {
                id: 'chat-ada',
                title: 'Billing review',
                createdAt: ago(70 * MINUTE),
                entries: [
                    {
                        type: 'message',
                        author: { kind: 'user', key: 'user' },
                        createdBy: OWNER_ID,
                        content: 'Review the billing PR',
                        at: ago(61 * MINUTE),
                    },
                    {
                        type: 'message',
                        author: { kind: 'agent', key: 'agent-ada' },
                        content: 'Done.',
                        at: ago(50 * MINUTE),
                    },
                ],
            },
        ],
        runs: [
            run(RUN_IDS.completed, {
                agentId: 'agent-ada',
                source: 'web',
                chatId: 'chat-ada',
                messageId: 'chat-ada#2',
                queuedAt: ago(61 * MINUTE),
                startedAt: ago(61 * MINUTE),
                completedAt: ago(50 * MINUTE),
                preview: 'Review the billing PR',
                progress: {
                    title: 'Review the billing pull request',
                    now: null,
                    next: null,
                    items: [
                        { id: 's1', text: 'Read the diff', status: 'completed' },
                        { id: 's2', text: 'Fix the reduce', status: 'completed' },
                    ],
                },
                usage: {
                    inputTokens: 18_200,
                    outputTokens: 2_150,
                    durationMs: 660_000,
                    cost: { amount: '1234.5', currency: 'USD' },
                },
                toolCalls: [
                    {
                        id: 'tool-1',
                        name: 'github.get_pull_request',
                        state: 'complete',
                        startedAt: ago(60 * MINUTE),
                        durationMs: 1_200,
                        logs: 'Fetched PR #42 (2 files).',
                        logsTruncated: false,
                    },
                ],
                outputs: {
                    messages: [{ chatId: 'chat-ada', messageId: 'chat-ada#2' }],
                    files: [],
                    projectChanges: [
                        {
                            projectName: 'billing',
                            commitHash: 'a'.repeat(40),
                            changedFiles: [{ path: 'src/billing.ts', insertions: 1, deletions: 1 }],
                            diff: SMALL_DIFF,
                            diffTruncated: false,
                        },
                    ],
                },
                report: { touchedProjects: ['billing'], externalSources: ['api.github.com'] },
            }),
            run(RUN_IDS.failed, {
                status: 'failed',
                agentId: 'agent-iris',
                source: 'schedule',
                createdBy: null,
                queuedAt: ago(40 * MINUTE),
                startedAt: ago(40 * MINUTE),
                completedAt: ago(30 * MINUTE),
                preview: 'Write the weekly report',
                usage: { inputTokens: null, outputTokens: null, durationMs: null, cost: null },
                error: { code: 'tool-timeout', summary: `The calendar did not answer: ${HOSTILE}` },
                toolCalls: [
                    {
                        id: 'tool-2',
                        name: 'calendar.list_events',
                        state: 'error',
                        startedAt: ago(39 * MINUTE),
                        durationMs: 30_000,
                        logs: `GET /events\n${HOSTILE}\ntimeout after 30 s`,
                        logsTruncated: true,
                    },
                ],
                outputs: {
                    messages: [],
                    files: [],
                    projectChanges: [
                        {
                            projectName: 'reports',
                            commitHash: 'b'.repeat(40),
                            changedFiles: [{ path: 'README.md', insertions: 1, deletions: 1 }],
                            diff: HOSTILE_DIFF,
                            diffTruncated: false,
                        },
                    ],
                },
            }),
            run(RUN_IDS.running, {
                status: 'running',
                agentId: 'agent-ada',
                source: 'api',
                queuedAt: ago(2 * MINUTE),
                startedAt: ago(90_000),
                completedAt: null,
                preview: 'Summarise the open pull requests',
                progress: {
                    title: 'Summarise open pull requests',
                    now: 'Reading pull request 7',
                    next: 'Write the summary',
                    items: [
                        { id: 'p1', text: 'List open pull requests', status: 'completed' },
                        { id: 'p2', text: 'Read each one', status: 'pending' },
                    ],
                },
            }),
            run(RUN_IDS.queued, {
                status: 'queued',
                agentId: 'agent-grace',
                source: 'email',
                createdBy: null,
                queuedAt: ago(MINUTE),
                startedAt: null,
                completedAt: null,
                attemptCount: 0,
                preview: 'Refund for order 1042',
            }),
            run(RUN_IDS.cancelled, {
                status: 'cancelled',
                agentId: 'agent-ada',
                source: 'webhook',
                createdBy: null,
                queuedAt: ago(100 * MINUTE),
                startedAt: ago(99 * MINUTE),
                completedAt: ago(98 * MINUTE),
                cancelRequestedAt: ago(98 * MINUTE),
            }),
            run(RUN_IDS.largeDiff, {
                agentId: 'agent-max',
                source: 'goal',
                queuedAt: ago(2 * 60 * MINUTE),
                startedAt: ago(2 * 60 * MINUTE),
                completedAt: ago(2 * 60 * MINUTE - MINUTE),
                preview: 'Import the data set',
                outputs: {
                    messages: [],
                    files: [],
                    projectChanges: [
                        {
                            projectName: 'data',
                            commitHash: 'c'.repeat(40),
                            changedFiles: [{ path: 'data.csv', insertions: LARGE_DIFF_LINES - 3, deletions: 0 }],
                            diff: largeDiff(),
                            diffTruncated: true,
                        },
                    ],
                },
            }),
            ...filler,
        ],
    };
}

type RunMethods = EngineApiClient['runs'];

export interface RunsEngine {
    /** Pass as `engineApi`; run methods are spies, so tests count, inspect and override calls. */
    readonly client: EngineApiClient;
    readonly controller: InMemoryEngineController;
    readonly spies: { readonly [Key in keyof RunMethods]: MockInstance<RunMethods[Key]> };
}

export interface RunsEngineOptions {
    readonly seed?: InMemorySeed;
    readonly permissions?: readonly Permission[];
    readonly capabilities?: readonly CapabilityRef[];
}

export function createRunsEngine(options: RunsEngineOptions = {}): RunsEngine {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: options.seed ?? runsSeed(),
        ...(options.permissions === undefined
            ? {}
            : { member: { id: OWNER_ID, permissions: options.permissions, role: 'member' } }),
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    });
    const runs = { ...engine.client.runs };
    const spies = {
        list: vi.spyOn(runs, 'list'),
        stats: vi.spyOn(runs, 'stats'),
        get: vi.spyOn(runs, 'get'),
        cancel: vi.spyOn(runs, 'cancel'),
        retry: vi.spyOn(runs, 'retry'),
    };
    return { client: { ...engine.client, runs }, controller: engine.controller, spies };
}
