import { describe, expect, it } from 'vitest';

import { createEngineRuntime } from '../domain/state/engine-runtime';
import { createFakeClock } from '../testing/fake-clock';
import { createRuntimeEngineStats } from './runtime-engine-stats';

function runtime() {
    return createEngineRuntime({
        seed: 42,
        scenario: 'small-team',
        epoch: new Date('2026-10-01T00:00:00Z'),
        identity: {
            engineId: 'abcdefghijklmnopqrstuvwxyz',
            hostname: 'abcdefghijklmnopqrstuvwxyz.engine.test',
            mode: 'tunnel',
            version: '0.4.2',
        },
        clock: createFakeClock(Date.parse('2026-10-20T08:00:00Z')),
    });
}

describe('createRuntimeEngineStats', () => {
    it('counts agents and active members from the engine state', () => {
        const engine = runtime();
        const snapshot = engine.controller().inspect();
        const stats = createRuntimeEngineStats(engine);
        expect(stats.counts()).toEqual({
            agents: snapshot.counts.agents,
            members: snapshot.members.filter((member) => member.status === 'active').length,
        });
        expect(stats.counts().agents).toBeGreaterThan(0);
    });

    it('leaves out members who are not active', () => {
        const engine = runtime();
        const stats = createRuntimeEngineStats(engine);
        const before = stats.counts().members;
        engine.controller().addMember({
            id: 'member-invited-0001',
            displayName: 'Invited',
            role: 'member',
            status: 'invited',
            createdAt: '2026-10-20T08:00:00Z',
            lastSeenAt: null,
        });
        engine.controller().addMember({
            id: 'member-active-0001',
            displayName: 'Active',
            role: 'member',
            status: 'active',
            createdAt: '2026-10-20T08:00:00Z',
            lastSeenAt: null,
        });
        expect(stats.counts().members).toBe(before + 1);
    });

    it('reads the current core after a reset', () => {
        const engine = runtime();
        const stats = createRuntimeEngineStats(engine);
        engine.reset({ seed: 1, scenario: 'empty' });
        expect(stats.counts()).toEqual({ agents: 0, members: 1 });
    });

    it('reports no update until the UI loader reports one', () => {
        expect(createRuntimeEngineStats(runtime()).updateState()).toBe('none');
    });
});
