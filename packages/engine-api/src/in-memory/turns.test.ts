import { describe, expect, it } from 'vitest';

import type { EngineApiClient, EngineApiResponse } from '../client';
import { AgentId, ChatId, MessageId } from '../common';
import type { EngineEvent } from '../events';
import { DEFAULT_CAPABILITIES, createInMemoryEngine } from '../in-memory-client';
import type { InMemoryEngineApiOptions, InMemorySeedChat } from '../in-memory-client';
import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import { MAX_REPLY_STEP_TEXT_LENGTH, MAX_REPLY_STEPS, MAX_WORKING_STEPS } from '../chats';
import type { ReadChatEntry } from '../chats';
import { createDemoSeed } from './demo-seed';
import { COPYWRITER_TASK_ID, COPYWRITER_TASK_NAME, demoReplyScript } from './demo-chats';
import type { ScriptedReply, Sleep } from './kit';
import { RECHECK_DELAY_MS, renderSteps, toStep } from './turns';

const AT = '2026-11-13T12:00:00.000Z';
const signal = () => AbortSignal.timeout(5_000);
const USER = { kind: 'user', key: 'user' } as const;
const ADA = { kind: 'agent', key: 'agent-ada' } as const;

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

/** A `Sleep` the test releases one call at a time. */
function steppedSleep() {
    const pending: { resolve: () => void; ms: number }[] = [];
    const sleep: Sleep = (ms) =>
        new Promise((resolve) => {
            pending.push({ resolve, ms });
        });
    return {
        sleep,
        pending: () => pending.map(({ ms }) => ms),
        async step(): Promise<void> {
            pending.shift()?.resolve();
            for (let index = 0; index < 5; index++) await Promise.resolve();
        },
    };
}

const STEPS = [
    { kind: 'reasoning', text: 'Look at the specs first.' },
    { kind: 'tool', tool: 'Glob', text: '{specs,tasks,agents}/**/*.md*' },
    { kind: 'tool', tool: 'Read', text: 'specs/_initial.md' },
] as const;

function setup(options: InMemoryEngineApiOptions & { readonly script?: () => ScriptedReply } = {}) {
    const { script, ...rest } = options;
    const engine = createInMemoryEngine({
        clock: { now: () => new Date(AT) },
        seed: {
            agents: [{ id: ADA.key, source: 'Ada' }],
            chats: [
                {
                    id: 'chat-1',
                    title: 'Specs',
                    createdAt: AT,
                    entries: [
                        { type: 'joined', participant: USER },
                        { type: 'joined', participant: ADA },
                    ],
                },
            ],
            tasks: [
                {
                    task: {
                        id: 'task-copy',
                        name: 'Write the copy',
                        kind: 'ordinary',
                        purpose: 'content',
                        core: false,
                        agentId: ADA.key,
                        executor: null,
                        priority: { rank: 0, text: null },
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
                        origin: null,
                        doneCount: 0,
                        lastDoneAt: null,
                        reopened: false,
                        allowedActions: [],
                        updatedAt: AT,
                        sourcePath: null,
                    },
                },
            ],
            ...rest.seed,
        },
        ...(script === undefined ? {} : { replyScript: script }),
        ...rest,
    });
    const events: EngineEvent[] = [];
    engine.controller.onEvent((event) => events.push(event));
    const chatId = ChatId.parse('chat-1');
    const changes = () => events.filter(({ type }) => type === 'chat.changed').length;
    return { ...engine, chatId, events, changes };
}

async function entries(client: EngineApiClient, chatId: ChatId): Promise<ReadChatEntry[]> {
    return ok(await client.chats.listEntries(chatId, { limit: 100 }, signal())).items.reverse();
}

const messages = async (client: EngineApiClient, chatId: ChatId) =>
    (await entries(client, chatId)).flatMap((entry) => (entry.type === 'message' ? [entry] : []));

/** Reads a reply to its end: an unpaced reply completes as it is read. */
async function drain(client: EngineApiClient, chatId: ChatId, messageId: string): Promise<string[]> {
    const stream = ok(await client.chats.streamReply(chatId, MessageId.parse(messageId), {}, signal()));
    const types: string[] = [];
    for await (const { event } of stream) types.push(event.type);
    return types;
}

describe('in-memory engine: an agent turn', () => {
    it('keeps a reply without steps an ordinary message', async () => {
        const { client, chatId } = setup();
        ok(await client.chats.sendMessage(chatId, { content: 'Hi' }, signal()));
        const busy = ok(await client.chats.get(chatId, signal()));
        expect(busy.working).toEqual([{ startedAt: AT, messageId: 'chat-1#2', author: ADA, steps: [] }]);
        await drain(client, chatId, 'chat-1#2');
        expect(ok(await client.chats.get(chatId, signal())).working).toEqual([]);
        expect((await messages(client, chatId)).at(-1)).toMatchObject({ phase: null, steps: [], status: 'completed' });
    });

    it('saves the steps as progress, then the final reply', async () => {
        const { client, chatId } = setup({ script: () => ({ steps: STEPS, chunks: ['Done.'] }) });
        ok(await client.chats.sendMessage(chatId, { content: 'Read the specs' }, signal()));
        const working = ok(await client.chats.get(chatId, signal())).working;
        expect(working).toEqual([
            { startedAt: AT, messageId: 'chat-1#3', author: ADA, steps: STEPS.map((step) => toStep(step)) },
        ]);
        await drain(client, chatId, 'chat-1#3');
        const [, progress, final] = await messages(client, chatId);
        expect(progress).toMatchObject({
            id: 'chat-1#2',
            phase: 'progress',
            status: 'completed',
            steps: [
                { kind: 'reasoning', tool: null, text: 'Look at the specs first.', level: 'info' },
                { kind: 'tool', tool: 'Glob', text: '{specs,tasks,agents}/**/*.md*', level: 'info' },
                { kind: 'tool', tool: 'Read', text: 'specs/_initial.md', level: 'info' },
            ],
            content:
                '- thinking: Look at the specs first.\n- Glob {specs,tasks,agents}/**/*.md*\n- Read specs/_initial.md',
        });
        expect(final).toMatchObject({ id: 'chat-1#3', phase: 'final', steps: [], content: 'Done.' });
        expect(ok(await client.chats.get(chatId, signal())).working).toEqual([]);
    });

    it('shows the agent working from the start of a paced turn and announces steps at most once a second', async () => {
        const paced = steppedSleep();
        const { client, chatId, changes } = setup({
            sleep: paced.sleep,
            script: () => ({
                steps: STEPS.map((step) => ({ ...step, delayMs: 10 })),
                chunks: [{ text: 'Done.', delayMs: 5 }],
            }),
        });
        ok(await client.chats.sendMessage(chatId, { content: 'Read the specs' }, signal()));
        const before = changes();
        expect(ok(await client.chats.get(chatId, signal())).working).toEqual([
            { startedAt: AT, messageId: null, author: ADA, steps: [] },
        ]);
        await paced.step();
        expect(changes()).toBe(before + 1);
        expect(ok(await client.chats.get(chatId, signal())).working[0]?.steps).toHaveLength(1);
        await paced.step();
        // The second step comes within the second: its announcement waits for the interval.
        expect(changes()).toBe(before + 1);
        expect(paced.pending()).toEqual([1000, 10]);
        await paced.step();
        expect(changes()).toBe(before + 2);
        await paced.step();
        // The last step's announcement waits again, but saving progress and starting the reply is announced at once.
        expect(changes()).toBe(before + 3);
        expect(paced.pending()).toEqual([1000, 5]);
        const busy = ok(await client.chats.get(chatId, signal())).working[0];
        expect(busy).toMatchObject({ messageId: 'chat-1#3', steps: STEPS.map((step) => toStep(step)) });
        await paced.step();
        expect(changes()).toBe(before + 4);
        await paced.step();
        expect(ok(await client.chats.get(chatId, signal())).working).toEqual([]);
        expect((await messages(client, chatId)).map(({ phase }) => phase)).toEqual([null, 'progress', 'final']);
    });

    it('ends the turn when the reply is cancelled, without a recheck', async () => {
        const { client, chatId } = setup({ script: () => ({ steps: STEPS, chunks: ['x'] }) });
        ok(await client.chats.sendMessage(chatId, { content: 'Go' }, signal()));
        ok(await client.chats.cancelReply(chatId, MessageId.parse('chat-1#3'), signal()));
        expect(ok(await client.chats.get(chatId, signal()))).toMatchObject({ working: [], recheck: null });
    });
});

describe('in-memory engine: rechecks', () => {
    function failingOnce() {
        let attempts = 0;
        return (): ScriptedReply => {
            attempts++;
            return attempts === 1 ? { chunks: ['Hmm'], outcome: 'failed' } : { chunks: ['Fixed.'] };
        };
    }

    it('leaves a recheck after a failed reply, and a retry attempts it again and clears it', async () => {
        const { client, chatId } = setup({ script: failingOnce() });
        ok(await client.chats.sendMessage(chatId, { content: 'Summarise the specs' }, signal()));
        await drain(client, chatId, 'chat-1#2');
        const failed = ok(await client.chats.get(chatId, signal()));
        expect(failed.working).toEqual([]);
        expect(failed.recheck).toEqual({
            aiToolId: null,
            cause: 'The reply failed.',
            nextAt: new Date(Date.parse(AT) + RECHECK_DELAY_MS).toISOString(),
            rounds: 1,
        });
        const retried = ok(await client.chats.retry(chatId, signal()));
        expect(retried.recheck).toBeNull();
        expect(retried.working).toMatchObject([{ author: ADA, messageId: 'chat-1#3' }]);
        // Asking again while the attempt runs changes nothing.
        expect(ok(await client.chats.retry(chatId, signal())).working).toHaveLength(1);
        await drain(client, chatId, 'chat-1#3');
        const done = ok(await client.chats.get(chatId, signal()));
        expect(done).toMatchObject({ working: [], recheck: null });
        expect((await messages(client, chatId)).at(-1)).toMatchObject({ content: 'Fixed.', status: 'completed' });
        expect(
            ok(await client.runs.list({}, signal()))
                .items.map(({ status }) => status)
                .sort(),
        ).toEqual(['completed', 'failed']);
    });

    it('counts the rounds of a reply that keeps failing', async () => {
        const { client, chatId } = setup({ script: () => ({ chunks: ['x'], outcome: 'failed' }) });
        ok(await client.chats.sendMessage(chatId, { content: 'Go' }, signal()));
        await drain(client, chatId, 'chat-1#2');
        ok(await client.chats.retry(chatId, signal()));
        await drain(client, chatId, 'chat-1#3');
        expect(ok(await client.chats.get(chatId, signal())).recheck?.rounds).toBe(2);
    });

    it('answers 409 nothing-to-retry without a recheck', async () => {
        const { client, chatId } = setup();
        const answer = await client.chats.retry(chatId, signal());
        expect(answer).toMatchObject({ kind: 'problem', problem: { status: 409, code: 'nothing-to-retry' } });
        expect(await client.chats.retry(ChatId.parse('chat-none'), signal())).toMatchObject({
            kind: 'problem',
            problem: { code: 'not-found' },
        });
    });

    it('drops a recheck whose agent is gone', async () => {
        const { client, chatId } = setup({ script: () => ({ chunks: ['x'], outcome: 'failed' }) });
        ok(await client.chats.sendMessage(chatId, { content: 'Go' }, signal()));
        await drain(client, chatId, 'chat-1#2');
        ok(await client.agents.delete(AgentId.parse(ADA.key), signal()));
        expect(await client.chats.retry(chatId, signal())).toMatchObject({
            kind: 'problem',
            problem: { code: 'nothing-to-retry' },
        });
        expect(ok(await client.chats.get(chatId, signal())).recheck).toBeNull();
    });

    it('needs chats.write to retry', async () => {
        const { client, chatId } = setup({ member: { permissions: ['chats.read'] } });
        expect(await client.chats.retry(chatId, signal())).toMatchObject({
            kind: 'problem',
            problem: { code: 'forbidden' },
        });
    });
});

describe('in-memory engine: levers for a live turn', () => {
    it('drives a turn step by step to its final reply', async () => {
        const { client, controller, chatId } = setup();
        const started = controller.startReplyTurn(chatId, ADA.key, 'Read the specs');
        expect(started.working).toEqual([{ startedAt: AT, messageId: null, author: ADA, steps: [] }]);
        expect(() => controller.startReplyTurn(chatId, ADA.key)).toThrow('already works');
        for (const step of STEPS) controller.addReplyStep(chatId, ADA.key, step);
        controller.addReplyStep(chatId, ADA.key, { kind: 'note', level: 'warning', text: 'Slow\nmodel' });
        expect(ok(await client.chats.get(chatId, signal())).working[0]?.steps.at(-1)).toEqual({
            kind: 'note',
            tool: null,
            text: 'Slow model',
            level: 'warning',
        });
        const reply = controller.finishReplyTurn(chatId, ADA.key, {
            content: '+@User Shall I start?',
            choices: ['Yes', 'No'],
        });
        expect(reply).toMatchObject({ phase: 'final', status: 'completed', choices: ['Yes', 'No'] });
        const chat = ok(await client.chats.get(chatId, signal()));
        expect(chat).toMatchObject({ working: [], status: 'waiting-for-user', questions: [{ messageId: reply.id }] });
        const [progress] = await messages(client, chatId);
        expect(progress?.content).toBe(`${renderSteps(STEPS.map((step) => toStep(step)))}\n- warning: Slow model`);
    });

    it('keeps the latest steps on the thread and splits a long turn into several progress messages', async () => {
        const { client, controller, chatId } = setup();
        controller.startReplyTurn(chatId, ADA.key);
        for (let index = 0; index < MAX_REPLY_STEPS + 5; index++) {
            controller.addReplyStep(chatId, ADA.key, { kind: 'tool', tool: 'Read', text: `file-${String(index)}` });
        }
        const working = ok(await client.chats.get(chatId, signal())).working[0];
        expect(working?.steps).toHaveLength(MAX_WORKING_STEPS);
        expect(working?.steps.at(-1)?.text).toBe(`file-${String(MAX_REPLY_STEPS + 4)}`);
        controller.finishReplyTurn(chatId, ADA.key, { content: 'Read them all.' });
        const saved = await messages(client, chatId);
        expect(saved.map(({ phase, steps }) => [phase, steps.length])).toEqual([
            ['progress', MAX_REPLY_STEPS],
            ['progress', 5],
            ['final', 0],
        ]);
    });

    it('refuses an invalid step and cuts a long one to its limit', () => {
        const { controller, chatId } = setup();
        controller.startReplyTurn(chatId, ADA.key);
        expect(() => controller.addReplyStep(chatId, ADA.key, { kind: 'tool', text: 'no tool' })).toThrow();
        expect(() =>
            controller.addReplyStep(chatId, ADA.key, { kind: 'reasoning', tool: 'Read', text: 'a tool' }),
        ).toThrow();
        const chat = controller.addReplyStep(chatId, ADA.key, { kind: 'reasoning', text: 'x'.repeat(2_000) });
        expect(chat.working[0]?.steps[0]?.text).toHaveLength(MAX_REPLY_STEP_TEXT_LENGTH);
    });

    it('fails a turn into a recheck the engine attempts by itself', async () => {
        const { client, controller, chatId } = setup();
        ok(await client.chats.sendMessage(chatId, { content: 'Summarise' }, signal()));
        await drain(client, chatId, 'chat-1#2');
        controller.startReplyTurn(chatId, ADA.key);
        const failed = controller.failReplyTurn(chatId, ADA.key, 'The model was overloaded.');
        expect(failed).toMatchObject({ working: [], recheck: { cause: 'The model was overloaded.', rounds: 1 } });
        const attempt = controller.recheckChat(chatId);
        expect(attempt).toMatchObject({ recheck: null, working: [{ author: ADA }] });
        await drain(client, chatId, 'chat-1#3');
        expect((await messages(client, chatId)).at(-1)?.content).toBe('Ada received: Summarise');
        expect(() => controller.recheckChat(chatId)).toThrow('No recheck');
    });

    it('throws for a thread, agent or turn it does not know', () => {
        const { controller, chatId } = setup();
        expect(() => controller.startReplyTurn('chat-none', ADA.key)).toThrow('No chat');
        expect(() => controller.startReplyTurn(chatId, 'agent-none')).toThrow('No live agent');
        expect(() => controller.addReplyStep(chatId, ADA.key, STEPS[0])).toThrow('does not work');
        expect(() => controller.finishReplyTurn(chatId, ADA.key, { content: 'x' })).toThrow('does not work');
        expect(() => controller.failReplyTurn(chatId, ADA.key)).toThrow('does not work');
    });
});

describe('in-memory engine: linked tasks', () => {
    it('links a task with a linked entry and moves it through its states', async () => {
        let now = AT;
        const { client, controller, chatId } = setup({ clock: { now: () => new Date(now) } });
        const linked = controller.linkChatTask(chatId, { name: 'Write the copy', agentId: ADA.key });
        expect(linked.tasks).toEqual([
            {
                name: 'Write the copy',
                taskId: 'task-copy',
                state: 'queued',
                detail: null,
                agentId: ADA.key,
                commit: null,
                reopened: false,
                startedAt: null,
                endedAt: null,
            },
        ]);
        expect((await entries(client, chatId)).at(-1)).toMatchObject({ type: 'linked', task: 'Write the copy' });
        now = '2026-11-13T12:01:00.000Z';
        controller.updateChatTask(chatId, 'Write the copy', { state: 'running', detail: 'executing · drafting' });
        now = '2026-11-13T12:02:00.000Z';
        controller.updateChatTask(chatId, 'Write the copy', { state: 'waiting' });
        now = '2026-11-13T12:03:00.000Z';
        const done = controller.updateChatTask(chatId, 'Write the copy', { state: 'completed', commit: '67b252ca' });
        expect(done.tasks[0]).toMatchObject({
            state: 'completed',
            startedAt: '2026-11-13T12:01:00.000Z',
            endedAt: '2026-11-13T12:03:00.000Z',
            commit: '67b252ca',
            reopened: false,
        });
        now = '2026-11-13T12:04:00.000Z';
        controller.updateChatTask(chatId, 'Write the copy', { state: 'retired' });
        expect(ok(await client.chats.get(chatId, signal())).tasks[0]?.endedAt).toBe('2026-11-13T12:03:00.000Z');
        const reopened = controller.updateChatTask(chatId, 'Write the copy', { state: 'queued' });
        expect(reopened.tasks[0]).toMatchObject({ reopened: false, endedAt: null });
        controller.updateChatTask(chatId, 'Write the copy', { state: 'cancelled' });
        const again = controller.updateChatTask(chatId, 'Write the copy', { state: 'running' });
        expect(again.tasks[0]).toMatchObject({ reopened: true, startedAt: '2026-11-13T12:01:00.000Z', endedAt: null });
    });

    it('resolves the task only on an engine with tasks@1, and refuses a duplicate or an unknown task', () => {
        const { controller, chatId } = setup({
            capabilities: DEFAULT_CAPABILITIES.filter((ref) => ref !== KNOWN_CAPABILITIES.tasks),
        });
        expect(controller.linkChatTask(chatId, { name: 'Write the copy' }).tasks[0]?.taskId).toBeNull();
        expect(() => controller.linkChatTask(chatId, { name: 'Write the copy' })).toThrow('already linked');
        expect(() => controller.updateChatTask(chatId, 'Other', { state: 'running' })).toThrow('not linked');
    });

    it('caps the tasks of one thread', () => {
        const { controller, chatId } = setup();
        for (let index = 0; index < 100; index++) controller.linkChatTask(chatId, { name: `Task ${String(index)}` });
        expect(() => controller.linkChatTask(chatId, { name: 'One more' })).toThrow('at most');
    });
});

describe('in-memory engine: seeded activity', () => {
    const seededChat = (fields: Partial<InMemorySeedChat>): InMemorySeedChat => ({
        id: 'chat-seeded',
        createdAt: AT,
        entries: [
            { type: 'joined', participant: USER },
            { type: 'joined', participant: ADA },
            { type: 'message', author: USER, createdBy: 'member-owner', content: 'Please check' },
        ],
        ...fields,
    });

    it('replays working agents and a recheck, which a retry attempts with the last User message', async () => {
        const prompts: string[] = [];
        const { client } = setup({
            seed: {
                agents: [{ id: ADA.key, source: 'Ada' }],
                chats: [
                    seededChat({
                        recheck: { cause: 'Overloaded.', nextAt: AT, rounds: 3 },
                        working: [{ author: ADA, startedAt: AT, steps: [STEPS[1]] }],
                    }),
                ],
            },
            script: () => ({ chunks: ['ok'] }),
            replyScript: (input) => {
                prompts.push(input.content);
                return { chunks: ['ok'] };
            },
        });
        const id = ChatId.parse('chat-seeded');
        const chat = ok(await client.chats.get(id, signal()));
        expect(chat.working).toEqual([{ startedAt: AT, messageId: null, author: ADA, steps: [toStep(STEPS[1])] }]);
        expect(chat.recheck).toEqual({ aiToolId: null, cause: 'Overloaded.', nextAt: AT, rounds: 3 });
        ok(await client.chats.retry(id, signal()));
        expect(prompts).toEqual(['Please check']);
    });

    it('refuses a seeded recheck without an agent to attempt it', () => {
        expect(() =>
            setup({
                seed: {
                    chats: [
                        {
                            id: 'chat-alone',
                            createdAt: AT,
                            entries: [{ type: 'joined', participant: USER }],
                            recheck: { cause: 'x', nextAt: AT, rounds: 1 },
                        },
                    ],
                },
            }),
        ).toThrow('no agent');
    });
});

describe('in-memory demo seed: the copywriter thread', () => {
    const now = new Date('2026-11-13T12:20:22.000Z');
    const demo = () =>
        createInMemoryEngine({ seed: createDemoSeed(now), clock: { now: () => now }, replyScript: demoReplyScript });

    it('replays the demo engine conversation with steps, the question, the linked task and its result', async () => {
        const { client } = demo();
        const chatId = ChatId.parse('chat-copywriter');
        const chat = ok(await client.chats.get(chatId, signal()));
        expect(chat).toMatchObject({
            title: 'Marketingový text o agentech',
            status: 'open',
            questions: [],
            working: [],
            recheck: null,
            tasks: [
                {
                    name: COPYWRITER_TASK_NAME,
                    taskId: COPYWRITER_TASK_ID,
                    state: 'completed',
                    agentId: 'agent-copywriter',
                    commit: '67b252ca',
                    endedAt: '2026-11-13T12:17:22.000Z',
                },
            ],
        });
        const items = await entries(client, chatId);
        const shape = items.map((entry) =>
            entry.type === 'message'
                ? `${entry.author.key}:${entry.phase ?? '-'}:${entry.steps.map(({ tool, kind }) => tool ?? kind).join(',')}`
                : entry.type,
        );
        expect(shape).toEqual([
            'joined',
            'joined',
            'user:-:',
            'builtin-chatter:-:',
            'titled',
            'user:-:',
            'builtin-chatter:progress:reasoning,Glob,Read',
            'builtin-chatter:final:',
            'status',
            'titled',
            'user:-:',
            'status',
            'builtin-chatter:progress:mcp__ptbk__create_task',
            'linked',
            'builtin-chatter:final:',
            'titled',
            'joined',
            'agent-copywriter:-:',
        ]);
        const question = items.find((entry) => entry.type === 'message' && entry.choices.length > 0);
        expect(question).toMatchObject({ content: expect.stringContaining('+@User') as unknown });
        expect(items.at(-1)).toMatchObject({
            content: expect.stringContaining(`Completed {${COPYWRITER_TASK_NAME}}`) as unknown,
        });
    });

    it('has a recheck waiting, an agent working without a word and a message nobody answers', async () => {
        const { client } = demo();
        const get = async (id: string) => ok(await client.chats.get(ChatId.parse(id), signal()));
        expect((await get('chat-recheck')).recheck).toMatchObject({ rounds: 1 });
        expect((await get('chat-working')).working).toMatchObject([{ messageId: null, steps: [] }]);
        expect(await get('chat-no-response')).toMatchObject({ working: [], recheck: null, messageCount: 1 });
        ok(await client.chats.retry(ChatId.parse('chat-recheck'), signal()));
        expect((await get('chat-recheck')).working).toMatchObject([{ author: { key: 'agent-max' }, steps: [] }]);
    });
});
