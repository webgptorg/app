import type { EngineApiClient, EngineApiResponse, EngineApiStreamItem, ReadEngineEvent } from '@ptbk/engine-api';
import { PERMISSIONS } from '@ptbk/engine-api';
import { afterEach, describe, expect, it } from 'vitest';

import type { ApiHarness } from '../src/testing/api-harness';
import { createApiHarness } from '../src/testing/api-harness';

let harness: ApiHarness | undefined;
afterEach(async () => {
    await harness?.close();
    harness = undefined;
});

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got ${response.problem.code}`);
    return response.data;
}

const signal = () => AbortSignal.timeout(10_000);

async function start() {
    harness = await createApiHarness();
    const engine = harness;
    const memberId = (role: string): string => {
        const member = engine
            .core()
            .controller.inspect()
            .members.find((candidate) => candidate.role === role);
        if (member === undefined) throw new Error(`no ${role}`);
        return member.id;
    };
    const owner = engine.client(engine.signIn({ memberId: engine.ownerId() }));
    const clientWith = (permissions: readonly (typeof PERMISSIONS)[number][]) =>
        engine.client(engine.signIn({ memberId: memberId('member'), permissions }));
    return { engine, owner, clientWith };
}

async function subscribe(client: EngineApiClient, lastEventId?: string) {
    const controller = new AbortController();
    const items = ok(await client.events.stream(lastEventId === undefined ? {} : { lastEventId }, controller.signal));
    const iterator = items[Symbol.asyncIterator]();
    return {
        async next(): Promise<EngineApiStreamItem<ReadEngineEvent>> {
            const result = await iterator.next();
            if (result.done === true) throw new Error('stream ended');
            return result.value;
        },
        close: () => {
            controller.abort();
        },
    };
}

async function renameFirstAgent(owner: EngineApiClient, name: string) {
    const [agent] = ok(await owner.agents.list({ origin: 'content', limit: 1 }, signal())).items;
    if (agent === undefined) throw new Error('no agent');
    const source = ok(await owner.agents.getSource(agent.id, signal()));
    const rest = source.source.split('\n').slice(1).join('\n');
    ok(
        await owner.agents.updateSource(
            agent.id,
            { source: `${name}\n${rest}`, baseRevisionId: source.revisionId },
            signal(),
        ),
    );
    return agent.id;
}

describe('GET /events', () => {
    it('announces an agent rename as agent.changed', async () => {
        const { engine, owner } = await start();
        const events = await subscribe(owner);
        const agentId = await renameFirstAgent(owner, 'Renamed Agent');
        expect((await events.next()).event).toEqual({ type: 'agent.changed', agentId });
        expect(ok(await owner.agents.get(agentId, signal())).name).toBe('Renamed Agent');
        events.close();
        await engine.recorder.settled();
        expect(engine.recorder.violations).toEqual([]);
    });

    it('is closed to a member without agents.read', async () => {
        const { clientWith } = await start();
        const blind = clientWith(PERMISSIONS.filter((permission) => permission !== 'agents.read'));
        const refused = await blind.events.stream({}, signal());
        expect(refused).toMatchObject({
            kind: 'problem',
            problem: { status: 403, code: 'forbidden', requiredPermission: 'agents.read' },
        });
    });

    it('sends chat.changed only to members with chats.read', async () => {
        const { owner, clientWith } = await start();
        const reader = await subscribe(clientWith(['agents.read', 'chats.read']));
        const agentsOnly = await subscribe(clientWith(['agents.read']));
        const [agent] = ok(await owner.agents.list({ origin: 'content', limit: 1 }, signal())).items;
        if (agent === undefined) throw new Error('no agent');
        const chat = ok(await owner.chats.create(agent.id, { title: 'Hello' }, signal()));
        ok(await owner.agents.update(agent.id, { visibility: 'public' }, signal()));
        expect((await reader.next()).event).toEqual({ type: 'chat.changed', chatId: chat.id });
        expect((await reader.next()).event).toEqual({ type: 'agent.changed', agentId: agent.id });
        // The first event this member sees is the later agent change: the chat change was filtered out.
        expect((await agentsOnly.next()).event).toEqual({ type: 'agent.changed', agentId: agent.id });
        reader.close();
        agentsOnly.close();
    });

    it('replays the events missed while disconnected after Last-Event-ID, in order', async () => {
        const { engine, owner } = await start();
        const first = await subscribe(owner);
        const firstAgent = await renameFirstAgent(owner, 'First Name');
        const seen = await first.next();
        first.close();
        const [, second, third] = ok(await owner.agents.list({ origin: 'content', limit: 3 }, signal())).items;
        if (second === undefined || third === undefined) throw new Error('agents expected');
        ok(await owner.agents.update(second.id, { visibility: 'unlisted' }, signal()));
        ok(await owner.agents.update(third.id, { visibility: 'unlisted' }, signal()));
        expect(seen.event).toEqual({ type: 'agent.changed', agentId: firstAgent });
        const resumed = await subscribe(owner, seen.id ?? undefined);
        const replayed = [await resumed.next(), await resumed.next()];
        expect(replayed.map(({ event }) => event)).toEqual([
            { type: 'agent.changed', agentId: second.id },
            { type: 'agent.changed', agentId: third.id },
        ]);
        expect(replayed.map(({ id }) => Number(id))).toEqual([Number(seen.id) + 1, Number(seen.id) + 2]);
        resumed.close();
        await engine.recorder.settled();
        expect(engine.recorder.violations).toEqual([]);
    });
});
