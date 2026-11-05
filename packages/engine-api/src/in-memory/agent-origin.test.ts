import { describe, expect, it } from 'vitest';

import { AgentListQuery } from '../agents';
import type { EngineApiResponse } from '../client';
import { createInMemoryEngine } from '../in-memory-client';

const signal = () => AbortSignal.timeout(5_000);

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`expected ok, got ${response.kind}`);
    return response.data;
}

describe('agent origin', () => {
    const { client } = createInMemoryEngine({
        seed: {
            agents: [
                { id: 'agent-ada', source: 'Ada\nPERSONA Research' },
                { id: 'agent-chatter', source: 'Chatter\nPERSONA Talks with you', origin: 'core' },
                { id: 'agent-expert', source: 'Expert\nPERSONA Knows the engine', origin: 'system' },
            ],
        },
    });
    const names = async (origin?: string) =>
        ok(await client.agents.list(origin === undefined ? {} : { origin }, signal())).items.map(({ name }) => name);

    it('lists every origin by default, and one origin or a set when asked', async () => {
        expect(await names()).toEqual(['Ada', 'Chatter', 'Expert']);
        expect(await names('content')).toEqual(['Ada']);
        expect(await names('core,system')).toEqual(['Chatter', 'Expert']);
    });

    it('creates content agents', async () => {
        const created = ok(await client.agents.create({ source: 'Grace\nPERSONA Review' }, signal()));
        expect(created.origin).toBe('content');
    });

    it('refuses an origin it does not know', () => {
        expect(AgentListQuery.safeParse({ origin: 'content,hidden' }).success).toBe(false);
        expect(AgentListQuery.safeParse({ origin: '' }).success).toBe(false);
    });
});
