import { randomUUID } from 'node:crypto';

import type { EngineApiResponse } from '@ptbk/engine-api';
import { ENGINE_API_PREFIX, ENGINE_API_ROUTE_LIST } from '@ptbk/engine-api';
import { afterEach, describe, expect, it } from 'vitest';

import type { ApiHarness } from '../src/testing/api-harness';
import { HARNESS_ORIGIN, createApiHarness } from '../src/testing/api-harness';
import type { FakeClock } from '../src/testing/fake-clock';
import { createFakeClock } from '../src/testing/fake-clock';

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
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const canary = () => `canary-${randomUUID()}-${randomUUID()}`;

async function drain(clock: FakeClock, idleTimers: number): Promise<void> {
    for (let step = 0; step < 5_000 && clock.pendingTimers() > idleTimers; step++) {
        clock.advance(100);
        await tick();
    }
}

/** Every spelling a value could leak in: as is, base64, base64url and hex, from its UTF-8 bytes. */
function spellings(value: string): string[] {
    const bytes = Buffer.from(value, 'utf8');
    return [value, bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('hex')];
}

describe('secret values', () => {
    it('never appear in any response, whatever route or stream', async () => {
        const clock = createFakeClock(Date.now());
        harness = await createApiHarness({ clock, rateLimiter: { consume: () => ({ kind: 'allowed' }) } });
        const engine = harness;
        const idleTimers = clock.pendingTimers();
        const cookie = engine.signIn({ memberId: engine.ownerId() });
        const client = engine.client(cookie);
        const fetch = engine.fetch(cookie);

        const disconnect = new AbortController();
        const events = await fetch(`${HARNESS_ORIGIN}${ENGINE_API_PREFIX}/events`, { signal: disconnect.signal });
        const eventReader = events.body?.getReader();
        const eventsRead = (async () => {
            for (;;) if ((await eventReader?.read())?.done !== false) return;
        })().catch(() => undefined);

        const written: string[] = [];
        const [agent] = ok(await client.agents.list({ limit: 1 }, signal())).items;
        if (agent === undefined) throw new Error('no agent');
        const engineSecret = canary();
        const agentSecret = canary();
        written.push(engineSecret, agentSecret);
        const first = ok(
            await client.secrets.create(
                { name: 'CANARY_ENGINE', scope: { kind: 'engine' }, value: engineSecret },
                signal(),
            ),
        );
        const second = ok(
            await client.secrets.create(
                { name: 'CANARY_AGENT', scope: { kind: 'agent', agentId: agent.id }, value: agentSecret },
                signal(),
            ),
        );
        for (const secret of [first, second]) {
            const replacement = canary();
            written.push(replacement);
            ok(await client.secrets.replaceValue(secret.id, { value: replacement }, signal()));
        }
        ok(await client.secrets.revoke(second.id, signal()));

        const chat = ok(await client.chats.create(agent.id, { title: 'Canary chat' }, signal()));
        const sent = ok(await client.chats.sendMessage(chat.id, { content: 'What secrets do you hold?' }, signal()));
        await drain(clock, idleTimers);

        const me = ok(await client.me.get(signal()));
        const [passkey] = ok(await client.me.listPasskeys({}, signal())).items;
        const [session] = ok(await client.me.listSessions({}, signal())).items;
        const [folder] = ok(await client.folders.list({}, signal())).items;
        const params: Record<string, string | undefined> = {
            agentId: agent.id,
            revisionId: agent.currentRevisionId,
            chatId: chat.id,
            messageId: sent.replyMessageId,
            memberId: me.memberId,
            secretId: first.id,
            passkeyId: passkey?.id,
            sessionId: session?.id,
            folderId: folder?.id,
        };
        const routes = ENGINE_API_ROUTE_LIST.filter(
            (route) => route.method === 'GET' && route.capability === undefined && route.id !== 'streamEvents',
        );
        for (const route of routes) {
            const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
                const value = params[name];
                if (value === undefined) throw new Error(`no ID for ${name} in ${route.id}`);
                return encodeURIComponent(value);
            });
            const response = await fetch(`${HARNESS_ORIGIN}${ENGINE_API_PREFIX}${path}`);
            expect(response.status, route.id).toBeLessThan(400);
            await response.arrayBuffer();
        }
        disconnect.abort();
        await eventsRead;
        await engine.recorder.settled();

        const bytes = engine.recorder.bytes().toString('utf8');
        expect(bytes).toContain('CANARY_ENGINE');
        expect(bytes).toContain('secret.replace');
        for (const value of written) {
            for (const spelling of spellings(value)) expect(bytes).not.toContain(spelling);
        }
        // Read raw: the client strips unknown fields, which would hide a `value` the engine sent.
        const raw = (await (await fetch(`${HARNESS_ORIGIN}${ENGINE_API_PREFIX}/secrets?limit=100`)).json()) as {
            items: Record<string, unknown>[];
        };
        expect(raw.items.length).toBeGreaterThanOrEqual(2);
        for (const secret of raw.items) expect(Object.keys(secret)).not.toContain('value');
        expect(engine.recorder.answered.size).toBeGreaterThan(routes.length);
        expect(engine.recorder.violations).toEqual([]);
    });
});
