import { describe, expect, it } from 'vitest';

import { AgentId } from '../common';
import type { EngineApiResponse } from '../client';
import { createInMemoryEngine } from '../in-memory-client';
import { createDemoSeed } from './demo-seed';

const signal = () => AbortSignal.timeout(5_000);

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`expected ok, got ${response.kind}`);
    return response.data;
}

describe('agent illustration', () => {
    it("serves a seeded owner's choice and leaves the rest to the UI", async () => {
        const { client } = createInMemoryEngine({
            seed: {
                agents: [
                    { id: 'agent-iris', source: 'Iris\nPERSONA Writes the weekly report', illustration: 'analyst' },
                    { id: 'agent-ada', source: 'Ada\nPERSONA Reviews pull requests' },
                ],
            },
        });
        expect(ok(await client.agents.get(AgentId.parse('agent-iris'), signal())).profile.illustration).toBe('analyst');
        expect(ok(await client.agents.get(AgentId.parse('agent-ada'), signal())).profile.illustration).toBeNull();
    });

    it('keeps the choice when the book changes, since no book sets it', async () => {
        const { client } = createInMemoryEngine({
            seed: { agents: [{ id: 'agent-max', source: 'Max\nPERSONA Answers email', illustration: 'support' }] },
        });
        const max = AgentId.parse('agent-max');
        const before = ok(await client.agents.get(max, signal()));
        ok(
            await client.agents.updateSource(
                max,
                { source: 'Max\nPERSONA Answers support email', baseRevisionId: before.currentRevisionId },
                signal(),
            ),
        );
        const after = ok(await client.agents.get(max, signal()));
        expect(after.profile).toMatchObject({ description: 'Answers support email', illustration: 'support' });
    });

    it('refuses a seeded illustration that is not an ID', () => {
        expect(() =>
            createInMemoryEngine({ seed: { agents: [{ source: 'Eve', illustration: '<svg onload=x>' }] } }),
        ).toThrow();
    });

    it('gives a few demo agents an explicit illustration', () => {
        const seeded = createDemoSeed(new Date('2026-11-16T12:00:00Z')).agents ?? [];
        expect(
            Object.fromEntries(seeded.flatMap(({ id, illustration }) => (illustration ? [[id, illustration]] : []))),
        ).toEqual({
            'agent-ada': 'developer',
            'agent-max': 'support',
            'agent-iris': 'analyst',
        });
    });
});
