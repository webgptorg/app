import type { EngineApiResponse } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import { describe, expect, it } from 'vitest';

import { SCENARIOS } from './scenarios';
import type { Scenario } from './scenarios';
import { HOSTILE_AGENT_NAME, ownerOf, seedEngine } from './seed';

const EPOCH = new Date('2026-10-01T00:00:00Z');
const signal = () => AbortSignal.timeout(5_000);

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

async function sha256(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function core(scenario: Scenario, seed = 42) {
    const data = seedEngine({ seed, scenario, epoch: EPOCH });
    const engine = createInMemoryEngine({
        seed: data,
        member: { id: ownerOf(data), role: 'owner' },
        clock: { now: () => EPOCH },
        capabilities: [],
    });
    return { data, ...engine };
}

/** Every timestamp in the seed, wherever it sits. */
function timestamps(value: unknown, found: string[] = []): string[] {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) found.push(value);
    else if (typeof value === 'object' && value !== null)
        for (const item of Object.values(value)) timestamps(item, found);
    return found;
}

describe('seedEngine', () => {
    it('gives a stable small-team seed for seed 42 and a fixed epoch', async () => {
        const json = JSON.stringify(seedEngine({ seed: 42, scenario: 'small-team', epoch: EPOCH }));
        expect(await sha256(json)).toBe('73300cec044fcb9f7882f06bec61de3691d1b6e71e488eb9e945aa31f7ac500b');
    });

    it('is byte-identical for the same inputs and changes with the seed, scenario or epoch', () => {
        const once = JSON.stringify(seedEngine({ seed: 42, scenario: 'small-team', epoch: EPOCH }));
        expect(JSON.stringify(seedEngine({ seed: 42, scenario: 'small-team', epoch: EPOCH }))).toBe(once);
        expect(JSON.stringify(seedEngine({ seed: 43, scenario: 'small-team', epoch: EPOCH }))).not.toBe(once);
        expect(JSON.stringify(seedEngine({ seed: 42, scenario: 'large-fleet', epoch: EPOCH }))).not.toBe(once);
        const later = new Date('2026-11-01T00:00:00Z');
        expect(JSON.stringify(seedEngine({ seed: 42, scenario: 'small-team', epoch: later }))).not.toBe(once);
    });

    it.each(SCENARIOS)('seeds %s into a working core with second-precision timestamps', async (scenario) => {
        const { data, client } = core(scenario);
        const me = ok(await client.me.get(signal()));
        expect(me).toMatchObject({ memberId: ownerOf(data), role: 'owner' });
        const members = ok(await client.members.list({ limit: 100 }, signal())).items;
        expect(members).toHaveLength(data.members?.length ?? 0);
        expect(ok(await client.audit.verify(signal())).status).toBe('intact');
        for (const at of timestamps({ ...data, sessions: [] })) {
            expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
            expect(Date.parse(at)).toBeLessThanOrEqual(EPOCH.getTime());
        }
    });

    it('seeds only the owner for empty', () => {
        const data = seedEngine({ seed: 1, scenario: 'empty', epoch: EPOCH });
        expect(data.members?.map(({ role }) => role)).toEqual(['owner']);
        expect(data.agents).toEqual([]);
        expect(data.chats).toEqual([]);
        expect(data.secrets).toEqual([]);
        expect(data.passkeys).toHaveLength(1);
    });

    it('gives small-team every role, a hostile agent, visitor chats and enough passkeys to test last-passkey', async () => {
        const { data, client } = core('small-team');
        const roles = data.members?.map(({ role }) => role).sort();
        expect(roles).toEqual(['admin', 'member', 'member', 'owner', 'viewer']);
        const agents = ok(await client.agents.list({ deleted: 'include', limit: 100 }, signal())).items;
        expect(agents.length).toBeGreaterThanOrEqual(7);
        expect(agents.filter(({ deletedAt }) => deletedAt !== null)).toHaveLength(1);
        expect(agents.map(({ name }) => name)).toContain(HOSTILE_AGENT_NAME);
        expect(new Set(agents.map(({ visibility }) => visibility)).size).toBeGreaterThan(1);
        const owner = ownerOf(data);
        expect(data.passkeys?.filter(({ memberId }) => memberId === owner).length).toBeGreaterThanOrEqual(2);
        for (const member of data.members?.filter(({ role }) => role === 'member') ?? []) {
            expect(
                agents.some(({ createdBy }) => createdBy === member.id),
                member.id,
            ).toBe(true);
        }
        const chats = ok(await client.chats.listAll({ limit: 100 }, signal())).items;
        expect(chats.length).toBeGreaterThanOrEqual(7);
        const [chat] = chats;
        if (chat) expect(ok(await client.chats.listMessages(chat.id, {}, signal())).items.length).toBeGreaterThan(2);
        const visitorChats = chats.filter(({ createdBy }) => createdBy === null);
        expect(visitorChats.length).toBeGreaterThan(0);
        const openAgents = new Set(agents.filter(({ visibility }) => visibility !== 'private').map(({ id }) => id));
        for (const visitorChat of visitorChats) {
            expect(visitorChat).toMatchObject({ source: 'web', title: '' });
            expect(visitorChat.preview).not.toBeNull();
            expect(openAgents.has(visitorChat.agentId)).toBe(true);
            const visitorMessages = ok(await client.chats.listMessages(visitorChat.id, {}, signal())).items;
            expect(visitorMessages).toHaveLength(visitorChat.messageCount);
            expect(visitorMessages.every(({ createdBy }) => createdBy === null)).toBe(true);
        }
        expect(chats.filter(({ createdBy }) => createdBy !== null).every(({ source }) => source === 'web')).toBe(true);
        const secrets = ok(await client.secrets.list({ limit: 100 }, signal())).items;
        expect(secrets.map(({ status }) => status)).toContain('revoked');
        expect(new Set(secrets.map(({ scope }) => scope.kind))).toEqual(new Set(['engine', 'agent']));
    });

    it('keeps secrets metadata-only', () => {
        for (const scenario of SCENARIOS) {
            for (const secret of seedEngine({ seed: 5, scenario, epoch: EPOCH }).secrets ?? []) {
                expect(Object.keys(secret).sort()).toEqual(
                    ['createdAt', 'createdBy', 'id', 'lastUsedAt', 'name', 'scope', 'status', 'updatedAt'].sort(),
                );
            }
        }
    });

    it('seeds large-fleet and builds its core in under 2 s, with chats long enough to page', async () => {
        const started = performance.now();
        const { data, client } = core('large-fleet');
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(2_000);
        expect(data.agents?.length).toBe(500);
        expect(data.members?.length).toBe(40);
        expect(new Set(data.members?.map(({ role }) => role))).toEqual(new Set(['owner', 'admin', 'member', 'viewer']));
        const counts = new Map<string, number>();
        for (const message of data.messages ?? []) counts.set(message.chatId, (counts.get(message.chatId) ?? 0) + 1);
        expect([...counts.values()].filter((count) => count >= 150).length).toBeGreaterThanOrEqual(3);
        expect(ok(await client.agents.list({ limit: 100 }, signal())).nextCursor).not.toBeNull();
    });
});
