import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { CapabilityRef } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { createTestRuntime } from '../testing/test-runtime';
import { createFakeClock } from '../testing/fake-clock';
import { createRuntimeEngineStats } from './runtime-engine-stats';

async function runtime(passkeys: 'seeded' | 'none' = 'seeded', capabilities?: readonly CapabilityRef[]) {
    return await createTestRuntime({
        passkeys,
        ...(capabilities === undefined ? {} : { capabilities }),
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
    it('counts agents that are not deleted and active members from the engine state', async () => {
        const engine = await runtime();
        const snapshot = engine.controller().inspect();
        const stats = createRuntimeEngineStats(engine);
        const live = snapshot.agents.filter((agent) => agent.deletedAt === null).length;
        // The seed keeps one agent in the trash; billing and the agent list leave it out, so the heartbeat does too.
        expect(live).toBe(snapshot.counts.agents - 1);
        expect(stats.counts()).toEqual({
            agents: live,
            members: snapshot.members.filter(
                (member) =>
                    member.status === 'active' && snapshot.passkeys.some(({ memberId }) => memberId === member.id),
            ).length,
        });
        expect(stats.counts().agents).toBeGreaterThan(0);
    });

    it('reports 0 members while the owner has yet to create a passkey (MOCK_PASSKEYS=none)', async () => {
        const engine = await runtime('none');
        const snapshot = engine.controller().inspect();
        expect(snapshot.members.length).toBeGreaterThan(1);
        expect(snapshot.passkeys).toEqual([]);
        expect(snapshot.sessions).toEqual([]);
        expect(createRuntimeEngineStats(engine).counts().members).toBe(0);
        await engine.reset({ seed: 2, scenario: 'empty' });
        expect(createRuntimeEngineStats(engine).counts().members).toBe(0);
    });

    it('counts only active members who hold a passkey', async () => {
        const engine = await runtime();
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
        // Neither can sign in yet: one is only invited, the other has no passkey.
        expect(stats.counts().members).toBe(before);
    });

    it('reads the current core after a reset', async () => {
        const engine = await runtime();
        const stats = createRuntimeEngineStats(engine);
        await engine.reset({ seed: 1, scenario: 'empty' });
        expect(stats.counts()).toEqual({ agents: 7, members: 1 });
    });

    it('reports setup pending on an engine paired before setup, done on a set-up one, and nothing without onboarding@1', async () => {
        // Without MOCK_ONBOARDING, an engine that waits for its owner is paired before its setup.
        expect(createRuntimeEngineStats(await runtime('none')).setup()).toBe('pending');
        expect(createRuntimeEngineStats(await runtime('seeded')).setup()).toBe('done');
        expect(createRuntimeEngineStats(await runtime('seeded', [KNOWN_CAPABILITIES.files])).setup()).toBeNull();
    });

    it('reports no update until the UI loader reports one', async () => {
        expect(createRuntimeEngineStats(await runtime()).updateState()).toBe('none');
    });
});
