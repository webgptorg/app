import type {
    AgentId,
    ChatId,
    EngineApiClient,
    EngineApiResponse,
    MessageId,
    ReplyStreamEvent,
} from '@ptbk/engine-api';
import { afterEach, describe, expect, it } from 'vitest';

import { HOSTILE_IMAGE, HOSTILE_LINK, HOSTILE_SCRIPT } from '../src/domain/chat/reply-generator';
import { HOSTILE_AGENT_NAME } from '../src/domain/state/seed';
import type { ApiHarness } from '../src/testing/api-harness';
import { createApiHarness } from '../src/testing/api-harness';
import type { FakeClock } from '../src/testing/fake-clock';
import { createFakeClock } from '../src/testing/fake-clock';

const harnesses: ApiHarness[] = [];
afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.close();
});

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got ${response.problem.code}`);
    return response.data;
}

const signal = () => AbortSignal.timeout(10_000);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Timers that are always there, such as the certificate renewal; set once the harness has started. */
let idleTimers = 0;

/** Paced replies sleep on the fake clock, one token at a time: step it until no reply is waiting any more. */
async function drain(clock: FakeClock): Promise<void> {
    for (let step = 0; step < 5_000 && clock.pendingTimers() > idleTimers; step++) {
        clock.advance(100);
        await tick();
    }
    expect(clock.pendingTimers()).toBe(idleTimers);
}

function start(seed = 42) {
    const clock = createFakeClock(Date.now());
    const harness = createApiHarness({ clock, seed });
    harnesses.push(harness);
    idleTimers = clock.pendingTimers();
    const client = harness.client(harness.signIn({ memberId: harness.ownerId() }));
    return { harness, clock, client };
}

async function agentNamed(client: EngineApiClient, name: (agentName: string) => boolean): Promise<AgentId> {
    const agents = ok(await client.agents.list({ limit: 100 }, signal())).items;
    const agent = agents.find((candidate) => name(candidate.name));
    if (agent === undefined) throw new Error('no such agent');
    return agent.id;
}

async function ask(client: EngineApiClient, agentId: AgentId, content = 'Show me how to deploy this') {
    const chat = ok(await client.chats.create(agentId, { title: 'Streaming test' }, signal()));
    const sent = ok(await client.chats.sendMessage(chat.id, { content }, signal()));
    return { chatId: chat.id, messageId: sent.replyMessageId };
}

async function readAll(client: EngineApiClient, chatId: ChatId, messageId: MessageId, lastEventId?: string) {
    const items = ok(
        await client.chats.streamReply(chatId, messageId, lastEventId === undefined ? {} : { lastEventId }, signal()),
    );
    const events: { id: string | null; event: ReplyStreamEvent }[] = [];
    for await (const item of items) events.push(item);
    return events;
}

function textOf(events: readonly { readonly event: ReplyStreamEvent }[]): string {
    return events.map(({ event }) => (event.type === 'delta' ? event.text : '')).join('');
}

async function generatedReply(seed: number): Promise<string> {
    const { clock, client, harness } = start(seed);
    const { chatId, messageId } = await ask(client, await agentNamed(client, (name) => name !== HOSTILE_AGENT_NAME));
    await drain(clock);
    const events = await readAll(client, chatId, messageId);
    expect(harness.recorder.violations).toEqual([]);
    return textOf(events);
}

describe('chat replies', () => {
    it('arrive as SSE delta tokens with a fenced code block, ending with the stored message', async () => {
        const { clock, client, harness } = start();
        const { chatId, messageId } = await ask(
            client,
            await agentNamed(client, (name) => name !== HOSTILE_AGENT_NAME),
        );
        const collected = readAll(client, chatId, messageId);
        await drain(clock);
        const events = await collected;
        const deltas = events.filter(({ event }) => event.type === 'delta');
        expect(deltas.length).toBeGreaterThan(20);
        expect(deltas.map(({ id }) => id)).toEqual(deltas.map((_, index) => String(index + 1)));
        const text = textOf(events);
        expect(text).toMatch(/```(?:ts|typescript|bash|json)\n[\s\S]+?\n```/);
        const last = events.at(-1)?.event;
        expect(last).toMatchObject({
            type: 'completed',
            message: { id: messageId, status: 'completed', content: text },
        });
        await harness.recorder.settled();
        expect(harness.recorder.violations).toEqual([]);
    });

    it('are identical for the same seed and differ for another', async () => {
        const first = await generatedReply(42);
        expect(await generatedReply(42)).toBe(first);
        expect(await generatedReply(43)).not.toBe(first);
    });

    it('from the injection demo agent carry content the UI must neutralise', async () => {
        const { clock, client } = start();
        const { chatId, messageId } = await ask(
            client,
            await agentNamed(client, (name) => name === HOSTILE_AGENT_NAME),
        );
        await drain(clock);
        const text = textOf(await readAll(client, chatId, messageId));
        for (const marker of [HOSTILE_IMAGE, HOSTILE_SCRIPT, HOSTILE_LINK]) expect(text).toContain(marker);
        expect(text.split('\n').some((line) => line.length > 2000)).toBe(true);
    });

    it('keep generating after a disconnect, which ends only that stream, and resume after Last-Event-ID', async () => {
        const { clock, client, harness } = start();
        const { chatId, messageId } = await ask(
            client,
            await agentNamed(client, (name) => name !== HOSTILE_AGENT_NAME),
        );
        const reader = new AbortController();
        const iterator = ok(await client.chats.streamReply(chatId, messageId, {}, reader.signal))[
            Symbol.asyncIterator
        ]();
        const seen: { id: string | null; event: ReplyStreamEvent }[] = [];
        while (seen.length < 5) {
            const next = iterator.next();
            for (let step = 0; step < 50; step++) {
                clock.advance(100);
                await tick();
            }
            const result = await next;
            if (result.done === true) throw new Error('ended early');
            seen.push(result.value);
        }
        const pending = iterator.next();
        reader.abort();
        await expect(pending).rejects.toThrow();
        await drain(clock);
        const stored = ok(await client.chats.listMessages(chatId, {}, signal())).items[0];
        expect(stored).toMatchObject({ id: messageId, status: 'completed' });
        const lastId = seen.at(-1)?.id ?? '';
        const resumed = await readAll(client, chatId, messageId, lastId);
        const seqs = resumed.flatMap(({ event }) => (event.type === 'delta' ? [event.seq] : []));
        expect(seqs[0]).toBe(Number(lastId) + 1);
        expect(new Set(seqs).size).toBe(seqs.length);
        expect(textOf(seen) + textOf(resumed)).toBe(stored?.content);
        await harness.recorder.settled();
        expect(harness.recorder.violations).toEqual([]);
    });

    it('stop generating only on the cancel route', async () => {
        const { clock, client, harness } = start();
        const { chatId, messageId } = await ask(
            client,
            await agentNamed(client, (name) => name !== HOSTILE_AGENT_NAME),
        );
        for (let step = 0; step < 10; step++) {
            clock.advance(100);
            await tick();
        }
        const collected = readAll(client, chatId, messageId);
        await tick();
        expect(ok(await client.chats.cancelReply(chatId, messageId, signal())).status).toBe('cancelled');
        const events = await collected;
        expect(events.at(-1)?.event).toMatchObject({ type: 'failed', problem: { code: 'cancelled' } });
        const before = textOf(events);
        await drain(clock);
        const stored = ok(await client.chats.listMessages(chatId, {}, signal())).items[0];
        expect(stored).toMatchObject({ id: messageId, status: 'cancelled', content: '' });
        expect(textOf(await readAll(client, chatId, messageId))).toBe('');
        expect(before.length).toBeLessThan(400);
        expect(ok(await client.chats.cancelReply(chatId, messageId, signal())).status).toBe('cancelled');
        await harness.recorder.settled();
        expect(harness.recorder.violations).toEqual([]);
    });
});
