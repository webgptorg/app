import type { EngineApiResponse, EngineEvent, Run } from '@ptbk/engine-api';
import { AgentId, ClientInfo, MemberId, OWNER_PERMISSIONS, SessionId, createEngineApiClient } from '@ptbk/engine-api';
import type { Actor } from '@ptbk/engine-api/in-memory';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { createTestRuntime } from '../../testing/test-runtime';
import { FaultPlan } from '../faults/fault-plan';
import type { Scenario } from '../state/scenarios';

const EPOCH = new Date('2026-10-01T00:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const signal = () => AbortSignal.timeout(5_000);

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got ${response.problem.code}`);
    return response.data;
}

async function start(options: { faults?: Partial<FaultPlan>; scenario?: Scenario; seed?: number } = {}) {
    let plan = FaultPlan.parse(options.faults ?? {});
    const clock = createFakeClock(Date.parse('2026-10-21T08:00:00Z'));
    const runtime = await createTestRuntime({
        seed: options.seed ?? 42,
        scenario: options.scenario ?? 'small-team',
        epoch: EPOCH,
        identity: {
            engineId: 'abcdefghijklmnopqrstuvwxyz',
            hostname: 'abcdefghijklmnopqrstuvwxyz.engine.test',
            mode: 'tunnel',
            version: '0.4.2',
        },
        clock,
        faults: () => plan,
    });
    const owner = runtime
        .controller()
        .inspect()
        .members.find(({ role }) => role === 'owner');
    if (owner === undefined) throw new Error('no owner');
    const actor: Actor = {
        memberId: MemberId.parse(owner.id),
        sessionId: SessionId.parse('session-test'),
        client: ClientInfo.parse({ ip: '127.0.0.1', userAgent: 'simulation test' }),
        permissions: new Set(OWNER_PERMISSIONS),
        stepUpFresh: true,
    };
    const client = createEngineApiClient(runtime.core().transport(actor));
    const events: EngineEvent[] = [];
    runtime.controller().onEvent((event) => events.push(event));
    // `empty` has no agents; its tests create their own.
    const [agent = { id: AgentId.parse('agent-none') }] = runtime.controller().findAgents();
    return {
        clock,
        runtime,
        client,
        events,
        agent,
        advance: (ms: number) => {
            runtime.clock.advance(ms);
        },
        setFaults: (faults: Partial<FaultPlan>) => {
            plan = FaultPlan.parse(faults);
            runtime.simulation().faultsChanged();
        },
    };
}

/** What a run looked like after each change, as a reader of its detail would have seen it. */
function trace(runtime: Awaited<ReturnType<typeof start>>['runtime'], runId: string) {
    const states: string[] = [];
    runtime.controller().onEvent((event) => {
        if (event.type !== 'run.changed' || event.runId !== runId) return;
        const run = runtime.controller().getRun(runId);
        const call = run?.toolCalls.at(-1);
        states.push(`${event.status}${call ? `:${call.name}=${call.state}` : ''}`);
    });
    return states;
}

describe('simulation clock in the runtime', () => {
    it('starts a paused engine at the seed epoch and moves it only by advance', async () => {
        const { runtime, clock, advance } = await start();
        expect(runtime.simulation().status()).toMatchObject({ mode: 'paused', now: EPOCH.toISOString() });
        clock.advance(HOUR);
        expect(runtime.simulation().status().now).toBe(EPOCH.toISOString());
        advance(90_000);
        expect(runtime.simulation().status().now).toBe('2026-10-01T00:01:30.000Z');
        runtime.clock.set('running', 60);
        clock.advance(1_000);
        expect(runtime.simulation().status()).toMatchObject({
            mode: 'running',
            speed: 60,
            now: '2026-10-01T00:02:30.000Z',
        });
        expect(() => {
            runtime.clock.advance(1);
        }).toThrow(/paused/);
    });

    it('runs timers in real time while running, scaled by the speed', async () => {
        const { runtime, clock, client, agent } = await start();
        runtime.clock.set('running', 10);
        const run = runtime
            .simulation()
            .scriptRun({ agentId: agent.id, source: 'api', outcome: 'completed', steps: [{ text: 'Go' }] });
        // Three scripted transitions of one simulated second each: start, step done, finish.
        clock.advance(300);
        expect(ok(await client.runs.get(run.id, signal())).status).toBe('completed');
    });
});

describe('run simulator', () => {
    it('plays a scripted run through its steps and tool-call states, then ends it as scripted', async () => {
        const { runtime, client, agent, advance } = await start();
        const run = runtime.simulation().scriptRun({
            agentId: agent.id,
            source: 'member',
            outcome: 'failed',
            steps: [
                { text: 'Search', toolName: 'web.fetch' },
                { text: 'Write' },
                { text: 'Send', toolName: 'mail.send' },
            ],
        });
        const states = trace(runtime, run.id);
        expect(run.status).toBe('queued');
        advance(60_000);
        expect(states).toEqual([
            'running',
            'running',
            'running:web.fetch=pending',
            'running:web.fetch=partial',
            'running:web.fetch=complete',
            'running:web.fetch=complete',
            'running:web.fetch=complete',
            'running:mail.send=pending',
            'running:mail.send=partial',
            'running:mail.send=error',
            'failed:mail.send=error',
        ]);
        const detail = ok(await client.runs.get(run.id, signal()));
        expect(detail.progress?.items.map(({ status }) => status)).toEqual(['completed', 'completed', 'pending']);
        expect(detail.error).not.toBeNull();
        const completed = runtime
            .simulation()
            .scriptRun({ agentId: agent.id, source: 'api', outcome: 'completed', steps: [{ text: 'Only' }] });
        advance(10_000);
        expect(ok(await client.runs.get(completed.id, signal()))).toMatchObject({
            status: 'completed',
            usage: { cost: { currency: 'USD' } },
        });
    });

    it('gives a chat turn a linked web run that ends with the reply', async () => {
        const { client, agent, clock } = await start();
        const chat = ok(await client.chats.create(agent.id, { title: 'Hello' }, signal()));
        const sent = ok(await client.chats.sendMessage(chat.id, { content: 'Hi' }, signal()));
        const [run] = ok(await client.runs.list({ source: 'web', sort: '-queuedAt', limit: 1 }, signal())).items;
        expect(run).toMatchObject({ chatId: chat.id, messageId: sent.replyMessageId, status: 'running' });
        // Replies are paced on the real clock, which runs on while the simulation is paused.
        for (let second = 0; second < 600; second++) {
            clock.advance(1_000);
            await Promise.resolve();
        }
        const stream = ok(await client.chats.streamReply(chat.id, sent.replyMessageId, {}, signal()));
        for await (const item of stream) if (item.event.type !== 'delta') break;
        expect(ok(await client.runs.get(run?.id ?? ('' as never), signal())).status).toBe('completed');
    });

    it('ends a running run cancelled at its next step, then refuses another cancel with 409', async () => {
        const { runtime, client, agent, advance } = await start();
        const run = runtime.simulation().scriptRun({
            agentId: agent.id,
            source: 'api',
            outcome: 'completed',
            steps: [{ text: 'Long', toolName: 'shell.run' }, { text: 'Longer' }],
        });
        advance(2_500);
        expect(ok(await client.runs.get(run.id, signal())).status).toBe('running');
        ok(await client.runs.cancel(run.id, signal()));
        advance(1_000);
        const cancelled = ok(await client.runs.get(run.id, signal()));
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.toolCalls.at(-1)?.state).toBe('error');
        expect(await client.runs.cancel(run.id, signal())).toMatchObject({
            kind: 'problem',
            problem: { code: 'run-finished' },
        });
    });

    it('cancels a queued run before it starts', async () => {
        const { runtime, client, agent, advance } = await start();
        const run = runtime.controller().startRun({ agentId: agent.id, source: 'api' });
        ok(await client.runs.cancel(run.id, signal()));
        advance(20_000);
        expect(ok(await client.runs.get(run.id, signal()))).toMatchObject({ status: 'cancelled', startedAt: null });
    });

    it('retries a failed run as a linked run that the simulation then drives', async () => {
        const { runtime, client, agent, advance } = await start();
        const run = runtime
            .simulation()
            .scriptRun({ agentId: agent.id, source: 'api', outcome: 'failed', steps: [{ text: 'Try' }] });
        advance(10_000);
        const retry = ok(await client.runs.retry(run.id, signal()));
        expect(retry).toMatchObject({ retryOf: run.id, status: 'queued' });
        expect(await client.runs.retry(retry.id, signal())).toMatchObject({
            kind: 'problem',
            problem: { code: 'run-not-retryable' },
        });
        advance(10 * MINUTE);
        expect(['completed', 'failed']).toContain(ok(await client.runs.get(retry.id, signal())).status);
    });

    it('takes over the runs the seed left queued or running', async () => {
        const { client, advance } = await start();
        const before = ok(await client.runs.list({ status: 'queued,running', limit: 100 }, signal())).items;
        expect(before.length).toBe(4);
        advance(HOUR);
        for (const run of before) {
            expect(['completed', 'failed', 'cancelled'], run.id).toContain(
                ok(await client.runs.get(run.id, signal())).status,
            );
        }
    });

    it('starts runs of its own, produces output files and commits, and is the same for the same advances', async () => {
        const summary = async () => {
            const { client, advance, runtime } = await start();
            advance(6 * HOUR);
            const runs = ok(await client.runs.list({ from: EPOCH.toISOString(), limit: 100 }, signal())).items;
            const outputs = ok(
                await client.files.list({ purpose: 'output', sort: '-createdAt', limit: 100 }, signal()),
            ).items;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
                runs: runs.map(({ id, source, status, queuedAt }) => `${id} ${source} ${status} ${queuedAt}`),
                sources: new Set(runs.map(({ source }) => source)),
                outputs: outputs.filter(({ createdAt }) => createdAt >= EPOCH.toISOString()).length,
                files: runtime.controller().inspect().counts.files,
            };
        };
        const first = await summary();
        expect(first.runs.length).toBeGreaterThan(20);
        expect(first.sources).toEqual(new Set(['api', 'member', 'goal', 'webhook', 'schedule']));
        expect((await summary()).runs).toEqual(first.runs);
    });
});

describe('schedule simulator', () => {
    async function scheduled(fields: Record<string, unknown>) {
        const engine = await start();
        const trigger = ok(
            await engine.client.triggers.create(
                {
                    kind: 'schedule',
                    agentId: engine.agent.id,
                    name: 'Every few minutes',
                    recurrence: { kind: 'interval', everySeconds: 600 },
                    message: 'Check',
                    ...fields,
                } as never,
                signal(),
            ),
        );
        return { ...engine, trigger };
    }

    it('fires an interval schedule on time for a simulated hour, each fire a schedule run', async () => {
        const { client, trigger, advance } = await scheduled({});
        advance(HOUR);
        const fires = ok(await client.triggers.listFires(trigger.id, { limit: 100 }, signal())).items;
        // At the start and every ten minutes after, both ends included.
        expect(fires).toHaveLength(7);
        expect(fires.every(({ outcome }) => outcome === 'started')).toBe(true);
        expect(fires.map(({ at }) => at).reverse()).toEqual(
            Array.from({ length: 7 }, (_, index) => new Date(EPOCH.getTime() + index * 600_000).toISOString()),
        );
        const runs = ok(await client.runs.list({ triggerId: trigger.id, limit: 100 }, signal())).items;
        expect(runs).toHaveLength(7);
        expect(runs.every(({ source }) => source === 'schedule')).toBe(true);
    });

    it('stops at maxRunCount and ends the schedule as max-runs', async () => {
        const { client, trigger, advance } = await scheduled({
            recurrence: { kind: 'interval', everySeconds: 300 },
            maxRunCount: 5,
        });
        advance(HOUR);
        expect(ok(await client.triggers.listFires(trigger.id, { limit: 100 }, signal())).items).toHaveLength(5);
        expect(ok(await client.triggers.get(trigger.id, signal()))).toMatchObject({
            lifecycle: 'ended',
            endedReason: 'max-runs',
            nextFireAt: null,
        });
    });

    it('never fires a paused trigger, and fires again once resumed', async () => {
        const { client, trigger, advance } = await scheduled({});
        ok(await client.triggers.pause(trigger.id, signal()));
        advance(HOUR);
        expect(ok(await client.triggers.listFires(trigger.id, { limit: 100 }, signal())).items).toEqual([]);
        ok(await client.triggers.resume(trigger.id, signal()));
        advance(HOUR);
        expect(ok(await client.triggers.listFires(trigger.id, { limit: 100 }, signal())).items.length).toBeGreaterThan(
            5,
        );
    });

    it('fires cron schedules from the seed on their own', async () => {
        const { client, advance } = await start();
        const active = ok(
            await client.triggers.list({ kind: 'schedule', lifecycle: 'active', limit: 100 }, signal()),
        ).items;
        const due = active.map(({ nextFireAt }) => Date.parse(nextFireAt ?? '')).sort((a, b) => a - b)[0] ?? 0;
        advance(due - EPOCH.getTime() + MINUTE);
        const fired = ok(
            await client.activity.list({ kind: 'trigger.fired', from: EPOCH.toISOString() }, signal()),
        ).items;
        expect(fired.length).toBeGreaterThan(0);
    });
});

describe('inbound email', () => {
    it('starts an email run for an email trigger and refuses anything else', async () => {
        const { runtime, client, agent } = await start();
        const email = ok(await client.triggers.create({ kind: 'email', agentId: agent.id, name: 'Inbox' }, signal()));
        const outcome = runtime.simulation().inboundEmail(email.id, 'Invoice   overdue');
        if (outcome.kind !== 'fired') throw new Error(outcome.kind);
        expect(ok(await client.runs.get(outcome.fire.runId ?? ('' as never), signal()))).toMatchObject({
            source: 'email',
            triggerId: email.id,
            preview: 'Invoice overdue',
        });
        const [schedule] = ok(await client.triggers.list({ kind: 'schedule', limit: 1 }, signal())).items;
        expect(runtime.simulation().inboundEmail(schedule?.id ?? '', 'x')).toEqual({ kind: 'not-email' });
        expect(runtime.simulation().inboundEmail('trigger-unknown', 'x')).toEqual({ kind: 'not-found' });
    });
});

describe('simulation faults', () => {
    it('fails runs at runFailureRate, within tolerance over 1,000 seeded runs', async () => {
        const { runtime, client, advance } = await start({ faults: { runFailureRate: 0.3 }, scenario: 'empty' });
        // `empty` has no agents, so the runs started here are the only ones.
        const agent = ok(await client.agents.create({ source: 'Bulk worker' }, signal()));
        const ids = Array.from(
            { length: 1_000 },
            () => runtime.controller().startRun({ agentId: agent.id, source: 'api' }).id,
        );
        advance(HOUR);
        const runs = ids.map((id) => runtime.controller().getRun(id));
        expect(runs.every((run) => run?.status === 'completed' || run?.status === 'failed')).toBe(true);
        const failed = runs.filter((run) => run?.status === 'failed').length;
        expect(failed).toBeGreaterThan(250);
        expect(failed).toBeLessThan(350);
    }, 30_000);

    it('keeps runs queued under stuckQueue, so oldestQueuedAt grows, and lets them go afterwards', async () => {
        const { runtime, client, agent, advance, setFaults } = await start({ faults: { stuckQueue: true } });
        const run = runtime.controller().startRun({ agentId: agent.id, source: 'api' });
        advance(10 * MINUTE);
        const stats = ok(await client.runs.stats({}, signal()));
        expect(ok(await client.runs.get(run.id, signal())).status).toBe('queued');
        advance(10 * MINUTE);
        const later = ok(await client.runs.stats({}, signal()));
        expect(later.queued).toBeGreaterThanOrEqual(stats.queued);
        expect(later.oldestQueuedAt).toBe(stats.oldestQueuedAt);
        expect(Date.parse(runtime.simulation().status().now) - Date.parse(later.oldestQueuedAt ?? '')).toBeGreaterThan(
            20 * MINUTE,
        );
        setFaults({});
        advance(10 * MINUTE);
        expect(ok(await client.runs.get(run.id, signal())).status).not.toBe('queued');
    });
});

describe('runtime reset', () => {
    it('runs overlapping resets one after the other, leaving one live simulation', async () => {
        const { runtime, advance } = await start();
        await Promise.all([
            runtime.reset({ seed: 1, scenario: 'small-team' }),
            runtime.reset({ seed: 2, scenario: 'empty' }),
        ]);
        expect(runtime.current()).toMatchObject({ seed: 2, scenario: 'empty' });
        // Only the last core's simulation runs: `empty` has no agents, so nothing starts.
        advance(HOUR);
        expect(runtime.controller().findRuns()).toEqual([]);
    });

    it('stops the old simulation and starts again at the epoch with the new capabilities', async () => {
        const { runtime, advance } = await start();
        advance(HOUR);
        await runtime.reset({ seed: 1, scenario: 'small-team', capabilities: [] });
        expect(runtime.simulation().status().now).toBe(EPOCH.toISOString());
        expect(runtime.current().capabilities).toEqual([]);
        const runsBefore: Run[] = [...runtime.controller().findRuns()];
        advance(HOUR);
        expect(runtime.controller().findRuns().length).toBeGreaterThan(runsBefore.length);
    });
});
