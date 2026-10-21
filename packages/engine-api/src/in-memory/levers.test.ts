import { describe, expect, it } from 'vitest';

import type { EngineApiClient, EngineApiResponse } from '../client';
import { FileId, IntegrationId, RunId } from '../common';
import { MAX_RUN_TEXT_BYTES } from '../constants';
import type { EngineEvent } from '../events';
import { createInMemoryEngine } from '../in-memory-client';
import type { InMemoryEngineApiOptions } from '../in-memory-client';
import { truncateRunText } from './runs';

const AT = '2026-10-19T08:00:00Z';
const COMMIT = 'a'.repeat(40);

function steppingClock(start = AT) {
    let tick = 0;
    return { now: () => new Date(Date.parse(start) + 1000 * tick++) };
}

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

function code(response: EngineApiResponse<unknown>): string {
    return response.kind === 'problem' ? response.problem.code : 'ok';
}

const signal = () => AbortSignal.timeout(5_000);
const engine = (options: InMemoryEngineApiOptions = {}) => createInMemoryEngine({ clock: steppingClock(), ...options });

async function agentIn(client: EngineApiClient, name = 'Ada') {
    return ok(await client.agents.create({ source: name }, signal()));
}

async function kinds(client: EngineApiClient, query: Parameters<EngineApiClient['activity']['list']>[0]) {
    return ok(await client.activity.list(query, signal())).items.map((item) =>
        item.kind === 'known' ? item.activity : null,
    );
}

describe('in-memory levers: runs', () => {
    it('starts a run for the system or a member, and refuses agents and members that do not exist', async () => {
        const { client, controller } = engine();
        const agent = await agentIn(client);
        const system = controller.startRun({ agentId: agent.id, source: 'goal', model: 'gpt-5', runner: 'codex' });
        expect(system).toMatchObject({ status: 'queued', source: 'goal', createdBy: null, model: 'gpt-5' });
        const member = controller.startRun({ agentId: agent.id, source: 'member', createdBy: 'member-owner' });
        expect(member.createdBy).toBe('member-owner');
        const queued = await kinds(client, { kind: 'run.queued' });
        expect(queued.map((activity) => activity?.actor)).toEqual([
            { kind: 'member', memberId: 'member-owner' },
            { kind: 'system' },
        ]);
        expect(() => controller.startRun({ agentId: 'agent-unknown', source: 'api' })).toThrow();
        expect(() => controller.startRun({ agentId: agent.id, source: 'api', createdBy: 'member-unknown' })).toThrow();
        ok(await client.agents.delete(agent.id, signal()));
        expect(() => controller.startRun({ agentId: agent.id, source: 'api' })).toThrow();
    });

    it('reports progress and tool calls by id, truncating logs, until the run finishes', async () => {
        const { client, controller } = engine();
        const agent = await agentIn(client);
        const { id } = controller.startRun({ agentId: agent.id, source: 'api' });
        const progress = {
            title: 'Triage',
            now: 'Reading',
            next: null,
            items: [{ id: 'a', text: 'Read', status: 'pending' }],
        };
        const call = {
            id: 'tool-1',
            name: 'web.search',
            state: 'pending',
            startedAt: null,
            durationMs: null,
            logs: '',
        };
        controller.reportRunProgress(id, { progress, toolCall: call, model: 'claude' });
        controller.reportRunProgress(id, { toolCall: { ...call, id: 'tool-2' } });
        controller.reportRunProgress(id, {
            toolCall: { ...call, state: 'complete', durationMs: 1200, logs: 'é'.repeat(MAX_RUN_TEXT_BYTES) },
        });
        const detail = ok(await client.runs.get(id, signal()));
        expect(detail.progress).toEqual(progress);
        expect(detail.model).toBe('claude');
        expect(detail.toolCalls.map(({ id: callId, state }) => [callId, state])).toEqual([
            ['tool-1', 'complete'],
            ['tool-2', 'pending'],
        ]);
        const [first] = detail.toolCalls;
        expect(first?.logsTruncated).toBe(true);
        expect(new TextEncoder().encode(first?.logs).byteLength).toBeLessThanOrEqual(MAX_RUN_TEXT_BYTES);
        expect(controller.getRun(id)?.toolCalls).toHaveLength(2);
        expect(() => controller.reportRunProgress(id, { toolCall: { ...call, state: 'stuck' } })).toThrow();
        controller.advanceRun(id);
        controller.advanceRun(id);
        expect(() => controller.reportRunProgress(id, { progress: null })).toThrow(/finished/);
        expect(() => controller.reportRunProgress('run-unknown', {})).toThrow();
    });

    it('adds project changes with truncated diffs and lists the project once', async () => {
        const { client, controller } = engine();
        const agent = await agentIn(client);
        const { id } = controller.startRun({ agentId: agent.id, source: 'api' });
        const change = {
            projectName: 'website',
            commitHash: COMMIT,
            changedFiles: [{ path: 'src/index.ts', insertions: 3, deletions: 1 }],
            diff: '+'.repeat(MAX_RUN_TEXT_BYTES + 10),
        };
        controller.addProjectChange(id, change);
        controller.addProjectChange(id, { ...change, diff: 'small', diffTruncated: false });
        const detail = ok(await client.runs.get(id, signal()));
        expect(detail.outputs.projectChanges.map(({ diffTruncated }) => diffTruncated)).toEqual([true, false]);
        expect(detail.outputs.projectChanges[0]?.diff).toHaveLength(MAX_RUN_TEXT_BYTES);
        expect(detail.report.touchedProjects).toEqual(['website']);
        expect(() => controller.addProjectChange(id, { ...change, commitHash: 'nope' })).toThrow();
    });

    it('cuts text on a character boundary', () => {
        const text = `${'a'.repeat(MAX_RUN_TEXT_BYTES - 1)}é`;
        expect(truncateRunText(text)).toEqual({ text: 'a'.repeat(MAX_RUN_TEXT_BYTES - 1), truncated: true });
        expect(truncateRunText('short')).toEqual({ text: 'short', truncated: false });
    });

    it('finds runs by status and reads one by ID', async () => {
        const { client, controller } = engine();
        const agent = await agentIn(client);
        const queued = controller.startRun({ agentId: agent.id, source: 'api' });
        const running = controller.startRun({ agentId: agent.id, source: 'api' });
        controller.advanceRun(running.id);
        expect(controller.findRuns({ status: ['queued'] }).map(({ id }) => id)).toEqual([queued.id]);
        expect(controller.findRuns()).toHaveLength(2);
        expect(controller.getRun(running.id)?.status).toBe('running');
        expect(controller.getRun('run-unknown')).toBeUndefined();
    });
});

describe('in-memory levers: files', () => {
    it("adds a run's output file to its outputs, with activity, and scans it with the engine's scanner", async () => {
        const { client, controller } = engine({
            checks: { scanFile: ({ name }) => (name.endsWith('.exe') ? 'infected' : 'clean') },
        });
        const agent = await agentIn(client);
        const { id: runId } = controller.startRun({ agentId: agent.id, source: 'api' });
        const content = new Blob(['# Report\n'], { type: 'text/markdown' });
        const file = await controller.addFile({
            name: 'report.md',
            contentType: 'text/markdown',
            content,
            purpose: 'output',
            agentId: agent.id,
            runId,
            createdBy: 'member-owner',
            commitHash: COMMIT,
        });
        expect(file).toMatchObject({ purpose: 'output', runId, scan: { status: 'clean' }, sizeBytes: content.size });
        expect(ok(await client.runs.get(runId, signal())).outputs.files).toEqual([file.id]);
        expect(ok(await client.files.listVersions(file.id, {}, signal())).items[0]?.commitHash).toBe(COMMIT);
        const downloaded: Blob = ok(await client.files.download(file.id, {}, signal()));
        expect(await downloaded.text()).toBe('# Report\n');
        const created = await kinds(client, { kind: 'file.created' });
        expect(created[0]).toMatchObject({ fileId: file.id, actor: { kind: 'system' } });
        const virus = await controller.addFile({
            name: 'invoice.exe',
            contentType: 'application/octet-stream',
            content: new Blob(['MZ']),
            purpose: 'attachment',
            createdBy: 'member-owner',
        });
        expect(virus.scan.status).toBe('infected');
        expect(code(await client.files.download(virus.id, {}, signal()))).toBe('file-infected');
        const pending = await controller.addFile({
            name: 'big.zip',
            contentType: 'application/zip',
            content: new Blob(['PK']),
            purpose: 'upload',
            createdBy: 'member-owner',
            scan: 'pending',
        });
        expect(pending.scan).toEqual({ status: 'pending', checkedAt: null });
        for (const bad of [{ agentId: 'agent-unknown' }, { runId: 'run-unknown' }, { createdBy: 'member-unknown' }]) {
            await expect(
                controller.addFile({
                    name: 'x.txt',
                    contentType: 'text/plain',
                    content: new Blob(['x']),
                    purpose: 'upload',
                    createdBy: 'member-owner',
                    ...bad,
                }),
            ).rejects.toThrow();
        }
    });

    it('sets scan results, reporting a failed scan, and scans uploads with the scanner', async () => {
        const { client, controller } = engine({ checks: { scanFile: () => 'pending' } });
        const form = {
            file: new Blob(['hello'], { type: 'text/plain' }),
            name: 'hello.txt',
            purpose: 'upload' as const,
        };
        const uploaded = ok(await client.files.upload(form, signal()));
        expect(uploaded.scan).toEqual({ status: 'pending', checkedAt: null });
        const events: EngineEvent[] = [];
        const stop = controller.onEvent((event) => events.push(event));
        expect(controller.setFileScan(uploaded.id, 'failed').scan.status).toBe('failed');
        stop();
        controller.setFileScan(uploaded.id, 'infected');
        expect(events.map(({ type }) => type)).toEqual(['file.changed', 'activity']);
        expect((await kinds(client, { kind: 'file.' })).map((activity) => activity?.kind)).toEqual([
            'file.scan-failed',
            'file.created',
        ]);
        expect(code(await client.files.download(FileId.parse(uploaded.id), {}, signal()))).toBe('file-infected');
        expect(() => controller.setFileScan('file-unknown', 'clean')).toThrow();
    });
});

describe('in-memory levers: integrations', () => {
    it("tests connections with the engine's probe and lets the engine report a status", async () => {
        let healthy = false;
        const { client, controller } = engine({
            checks: {
                probeIntegration: () =>
                    healthy ? { status: 'connected' } : { status: 'error', statusDetail: 'Connection refused.' },
            },
        });
        const created = ok(
            await client.integrations.create(
                { kind: 'mcp-server', name: 'Docs', url: 'https://docs.example.com/mcp' },
                signal(),
            ),
        );
        expect(created).toMatchObject({ status: 'error', statusDetail: 'Connection refused.' });
        healthy = true;
        expect(ok(await client.integrations.check(created.id, signal())).status).toBe('connected');
        const broken = controller.setIntegrationStatus(created.id, {
            status: 'needs-attention',
            statusDetail: 'Expired.',
        });
        expect(broken).toMatchObject({ status: 'needs-attention', statusDetail: 'Expired.' });
        expect(
            controller.setIntegrationStatus(created.id, { status: 'connected', statusDetail: 'x' }).statusDetail,
        ).toBeNull();
        const activity = await kinds(client, { integrationId: created.id });
        expect(activity.map((item) => [item?.kind, item?.actor.kind])).toEqual([
            ['integration.connected', 'system'],
            ['integration.error', 'system'],
            ['integration.connected', 'member'],
            ['integration.error', 'member'],
        ]);
        expect(() =>
            controller.setIntegrationStatus(IntegrationId.parse('integration-unknown'), { status: 'error' }),
        ).toThrow();
        expect(() =>
            controller.setIntegrationStatus(created.id, { status: 'error', statusDetail: 'x'.repeat(2000) }),
        ).toThrow();
    });
});

describe('in-memory levers: trigger lifecycle', () => {
    async function scheduled(fields: Record<string, unknown> = {}, options: InMemoryEngineApiOptions = {}) {
        const { client, controller } = engine(options);
        const agent = await agentIn(client);
        const trigger = ok(
            await client.triggers.create(
                {
                    kind: 'schedule',
                    agentId: agent.id,
                    name: 'Hourly',
                    recurrence: { kind: 'interval', everySeconds: 3600 },
                    message: 'Check the inbox',
                    ...fields,
                },
                signal(),
            ),
        );
        return { client, controller, agent, trigger };
    }

    it('skips a fire before startsAt and leaves the schedule active', async () => {
        const { client, controller, trigger } = await scheduled({ startsAt: '2026-10-25T00:00:00Z' });
        expect(controller.fireTrigger(trigger.id)).toMatchObject({ outcome: 'skipped', runId: null });
        expect(ok(await client.triggers.get(trigger.id, signal()))).toMatchObject({ lifecycle: 'active' });
        expect(ok(await client.runs.list({}, signal())).items).toEqual([]);
    });

    it('ends a schedule fired after its endsAt as completed', async () => {
        let nowMs = Date.parse(AT);
        const { client, controller, trigger } = await scheduled(
            { endsAt: '2026-10-19T09:00:00Z' },
            { clock: { now: () => new Date(nowMs) } },
        );
        nowMs = Date.parse('2026-10-19T09:00:00Z');
        expect(controller.fireTrigger(trigger.id)).toMatchObject({ outcome: 'skipped' });
        expect(ok(await client.triggers.get(trigger.id, signal()))).toMatchObject({
            lifecycle: 'ended',
            endedReason: 'completed',
            nextFireAt: null,
        });
    });

    it('records a failed fire and trigger.failed once the agent is deleted', async () => {
        const { client, controller, agent, trigger } = await scheduled();
        ok(await client.agents.delete(agent.id, signal()));
        const fire = controller.fireTrigger(trigger.id);
        expect(fire).toMatchObject({ outcome: 'failed', runId: null, error: { code: 'agent-unavailable' } });
        expect((await kinds(client, { triggerId: trigger.id }))[0]).toMatchObject({
            kind: 'trigger.failed',
            error: { code: 'agent-unavailable' },
        });
        expect(ok(await client.runs.list({}, signal())).items).toEqual([]);
    });

    it('ends a seeded schedule that already reached maxRunCount, without a run', async () => {
        const at = '2026-10-18T08:00:00Z';
        const { client, controller } = engine({
            seed: {
                agents: [{ id: 'agent-ada', source: 'Ada' }],
                triggers: [
                    {
                        trigger: {
                            id: 'trigger-capped',
                            agentId: 'agent-ada',
                            name: 'Capped',
                            kind: 'schedule',
                            lifecycle: 'active',
                            endedReason: null,
                            lastFiredAt: at,
                            nextFireAt: AT,
                            createdBy: 'member-owner',
                            createdAt: at,
                            updatedAt: at,
                            config: {
                                recurrence: { kind: 'interval', everySeconds: 3600 },
                                startsAt: at,
                                endsAt: null,
                                maxRunCount: 2,
                                runCount: 2,
                                message: 'Go',
                            },
                        },
                    },
                ],
            },
        });
        expect(controller.fireTrigger('trigger-capped').outcome).toBe('skipped');
        expect(controller.getTrigger('trigger-capped')).toMatchObject({ lifecycle: 'ended', endedReason: 'max-runs' });
        expect(controller.findTriggers({ lifecycle: 'ended', kind: 'schedule' })).toHaveLength(1);
        expect(controller.findTriggers({ lifecycle: 'active' })).toEqual([]);
        expect(controller.findTriggers()).toHaveLength(1);
        expect(controller.getTrigger('trigger-unknown')).toBeUndefined();
        expect(ok(await client.runs.list({}, signal())).items).toEqual([]);
    });
});

describe('in-memory levers: agents and events', () => {
    it('lists live agents only and stops notifying after unsubscribing', async () => {
        const { client, controller } = engine();
        const kept = await agentIn(client, 'Kept');
        const gone = await agentIn(client, 'Gone');
        const seen: string[] = [];
        const stop = controller.onEvent((event) => seen.push(event.type));
        ok(await client.agents.delete(gone.id, signal()));
        stop();
        controller.emit({ type: 'chat.changed', chatId: 'chat-x' });
        expect(seen).toEqual(['agent.changed']);
        expect(controller.findAgents().map(({ id }) => id)).toEqual([kept.id]);
        expect(RunId.safeParse('run-1').success).toBe(true);
    });
});
