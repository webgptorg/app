import type { EngineApiResponse } from '@ptbk/engine-api';
import { ClientInfo, MemberId, OWNER_PERMISSIONS, SessionId, createEngineApiClient } from '@ptbk/engine-api';
import type { Actor } from '@ptbk/engine-api/in-memory';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { HOSTILE_IMAGE, HOSTILE_SCRIPT } from '../chat/reply-generator';
import { createEngineRuntime } from './engine-runtime';
import { HOSTILE_AGENT_NAME } from './seed';

const IDENTITY = {
    engineId: 'abcdefghijklmnopqrstuvwxyz',
    hostname: 'abcdefghijklmnopqrstuvwxyz.engine.test',
    mode: 'tunnel',
    version: '0.4.2',
} as const;

const signal = () => AbortSignal.timeout(5_000);

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got ${response.problem.code}`);
    return response.data;
}

function start() {
    const clock = createFakeClock(Date.parse('2026-10-20T08:00:00Z'));
    const runtime = createEngineRuntime({
        seed: 42,
        scenario: 'small-team',
        epoch: new Date('2026-10-01T00:00:00Z'),
        identity: IDENTITY,
        clock,
    });
    const actorOf = (): Actor => {
        const owner = runtime
            .controller()
            .inspect()
            .members.find(({ role }) => role === 'owner');
        if (owner === undefined) throw new Error('no owner');
        return {
            memberId: MemberId.parse(owner.id),
            sessionId: SessionId.parse('session-test'),
            client: ClientInfo.parse({ ip: '127.0.0.1', userAgent: 'runtime test' }),
            permissions: new Set(OWNER_PERMISSIONS),
            stepUpFresh: true,
        };
    };
    // The core's own transport, with no HTTP in between: the runtime is domain code.
    const client = () => createEngineApiClient(runtime.core().transport(actorOf()));
    return { clock, runtime, client };
}

describe('engine runtime', () => {
    it('reports the identity, version and mode, with no capabilities', async () => {
        const { client } = start();
        expect(ok(await client().engine.get(signal()))).toMatchObject({
            engineId: IDENTITY.engineId,
            hostname: IDENTITY.hostname,
            mode: 'tunnel',
            dashboardUrl: null,
            capabilities: [],
        });
        expect(ok(await client().security.get(signal()))).toMatchObject({
            engine: { version: '0.4.2' },
            hostnames: [{ hostname: IDENTITY.hostname, kind: 'default' }],
            relays: [],
        });
    });

    it('applies relay states, hostnames and the dashboard URL, and keeps them across a reset', async () => {
        const { clock, runtime, client } = start();
        runtime.setRelayStatus('relay-a.ptbk.test', 'connecting');
        clock.advance(1_000);
        runtime.setRelayStatus('relay-a.ptbk.test', 'connected');
        clock.advance(1_000);
        runtime.setRelayStatus('relay-a.ptbk.test', 'connected');
        runtime.setRelayStatus('relay-b.ptbk.test', 'disconnected');
        runtime.setHostnames([IDENTITY.hostname, 'agents.customer.test']);
        runtime.setDashboardUrl('https://app.ptbk.test/engines/abc');
        const heartbeat = { sentAt: '2026-10-20T08:00:02Z', body: '{"v":1}' };
        runtime.setLastHeartbeat(heartbeat);
        const listened: string[] = [];
        runtime.onReset(() => listened.push('reset'));
        const before = ok(await client().security.get(signal()));
        runtime.reset({ seed: 7, scenario: 'empty' });
        expect(runtime.current()).toEqual({ seed: 7, scenario: 'empty' });
        expect(listened).toEqual(['reset']);
        expect(runtime.controller().inspect().counts).toMatchObject({ members: 1, agents: 0 });
        const after = ok(await client().security.get(signal()));
        expect(after.relays).toEqual(before.relays);
        expect(after.lastHeartbeat).toEqual(heartbeat);
        expect(after.relays).toEqual([
            { hostname: 'relay-a.ptbk.test', status: 'connected', since: '2026-10-20T08:00:01Z' },
            { hostname: 'relay-b.ptbk.test', status: 'disconnected', since: '2026-10-20T08:00:02Z' },
        ]);
        expect(after.hostnames).toEqual([
            { hostname: IDENTITY.hostname, kind: 'default' },
            { hostname: 'agents.customer.test', kind: 'custom' },
        ]);
        expect(ok(await client().engine.get(signal())).dashboardUrl).toBe('https://app.ptbk.test/engines/abc');
    });

    it("answers the injection demo agent with hostile markdown, paced on the runtime's clock", async () => {
        const { clock, client } = start();
        const agents = ok(await client().agents.list({ limit: 100 }, signal())).items;
        const hostile = agents.find(({ name }) => name === HOSTILE_AGENT_NAME);
        if (hostile === undefined) throw new Error('no hostile agent');
        const chat = ok(await client().chats.create(hostile.id, {}, signal()));
        const sent = ok(await client().chats.sendMessage(chat.id, { content: 'hi' }, signal()));
        for (let step = 0; step < 5_000 && clock.pendingTimers() > 0; step++) {
            clock.advance(100);
            await new Promise((resolve) => setImmediate(resolve));
        }
        const stream = ok(await client().chats.streamReply(chat.id, sent.replyMessageId, {}, signal()));
        let text = '';
        for await (const { event } of stream) {
            if (event.type === 'delta') text += event.text;
            else expect(event.type).toBe('completed');
        }
        expect(text).toContain(HOSTILE_IMAGE);
        expect(text).toContain(HOSTILE_SCRIPT);
    });

    it('stops waiting when a paced sleep is cancelled', async () => {
        const { clock, client } = start();
        const [agent] = ok(await client().agents.list({}, signal())).items;
        if (agent === undefined) throw new Error('no agent');
        const chat = ok(await client().chats.create(agent.id, {}, signal()));
        const sent = ok(await client().chats.sendMessage(chat.id, { content: 'hi' }, signal()));
        expect(clock.pendingTimers()).toBe(1);
        ok(await client().chats.cancelReply(chat.id, sent.replyMessageId, signal()));
        expect(clock.pendingTimers()).toBe(0);
    });
});
