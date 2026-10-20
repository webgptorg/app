import { describe, expect, it } from 'vitest';

import type { EngineApiClient, EngineApiResponse } from '../client';
import { AgentId, FileId, FileVersionId, IntegrationId, RunId, TriggerId } from '../common';
import type { ReadEngineEvent } from '../events';
import { createInMemoryEngine } from '../in-memory-client';
import type { InMemoryEngineApiOptions } from '../in-memory-client';
import { PERMISSIONS } from '../permissions';
import type { EngineApiStreamItem } from '../route';
import { createDemoSeed } from './demo-seed';

const AT = '2026-10-19T08:00:00Z';

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

async function schedule(
    client: EngineApiClient,
    agentId: AgentId,
    fields: Partial<Parameters<EngineApiClient['triggers']['create']>[0]> = {},
) {
    return ok(
        await client.triggers.create(
            {
                kind: 'schedule',
                agentId,
                name: 'Hourly',
                recurrence: { kind: 'interval', everySeconds: 3600 },
                message: 'Check the inbox',
                ...fields,
            },
            signal(),
        ),
    );
}

async function drain<T>(items: AsyncIterable<EngineApiStreamItem<T>>): Promise<number> {
    const all: EngineApiStreamItem<T>[] = [];
    for await (const item of items) all.push(item);
    return all.length;
}

async function take<T>(items: AsyncIterable<EngineApiStreamItem<T>>, count: number): Promise<T[]> {
    const taken: T[] = [];
    if (count === 0) return taken;
    for await (const item of items) {
        taken.push(item.event);
        if (taken.length === count) break;
    }
    return taken;
}

describe('in-memory controller: runs', () => {
    async function queued() {
        const { client, controller } = engine();
        const agent = await agentIn(client);
        const trigger = await schedule(client, agent.id);
        const fire = controller.fireTrigger(trigger.id);
        if (fire.runId === null) throw new Error('no run');
        return { client, controller, runId: fire.runId };
    }

    it('starts a queued run and completes it with its duration', async () => {
        const { client, controller, runId } = await queued();
        expect(controller.advanceRun(runId)).toMatchObject({ status: 'running', attemptCount: 1 });
        const done = controller.advanceRun(runId);
        expect(done.status).toBe('completed');
        expect(done.usage?.durationMs).toBeGreaterThan(0);
        expect(controller.advanceRun(runId, { status: 'failed', error: { code: 'late', summary: 'x' } }).status).toBe(
            'completed',
        );
        const kinds = ok(await client.activity.list({ runId }, signal())).items.map((item) =>
            item.kind === 'known' ? item.activity.kind : item.kind,
        );
        expect(kinds).toEqual(['run.completed', 'run.started', 'trigger.fired', 'run.queued']);
        expect(ok(await client.activity.list({ runId, kind: 'run.' }, signal())).items).toHaveLength(3);
        expect(ok(await client.runs.stats({}, signal()))).toMatchObject({ running: 0, queued: 0 });
    });

    it('fails a running run, which can then be retried once', async () => {
        const { client, controller, runId } = await queued();
        controller.advanceRun(runId);
        const failed = controller.advanceRun(runId, { status: 'failed', error: { code: 'tool-error', summary: 'No' } });
        expect(failed).toMatchObject({ status: 'failed', error: { code: 'tool-error' } });
        expect(ok(await client.runs.stats({}, signal())).failedLast24h).toBe(1);
        const retry = ok(await client.runs.retry(runId, signal()));
        expect(retry).toMatchObject({
            status: 'queued',
            retryOf: runId,
            source: 'schedule',
            createdBy: 'member-owner',
        });
        expect(code(await client.runs.retry(retry.id, signal()))).toBe('run-not-retryable');
        expect(code(await client.runs.cancel(runId, signal()))).toBe('run-finished');
    });

    it('cancels a run once a cancel was requested', async () => {
        const { client, controller, runId } = await queued();
        const requested = ok(await client.runs.cancel(runId, signal()));
        expect(requested.cancelRequestedAt).not.toBeNull();
        expect(ok(await client.runs.cancel(runId, signal())).cancelRequestedAt).toBe(requested.cancelRequestedAt);
        expect(controller.advanceRun(runId).status).toBe('cancelled');
        expect(code(await client.runs.cancel(runId, signal()))).toBe('run-finished');
        expect(controller.advanceRun(runId).status).toBe('cancelled');
    });

    it('cancels a queued run directly and refuses an unknown run', async () => {
        const { controller, runId } = await queued();
        expect(controller.advanceRun(runId, { status: 'cancelled' }).status).toBe('cancelled');
        expect(() => controller.advanceRun('run-unknown')).toThrow();
    });

    it('filters, sorts and counts runs', async () => {
        const { client, controller, runId } = await queued();
        controller.advanceRun(runId);
        const runs = ok(await client.runs.list({ status: 'running,queued', sort: 'queuedAt' }, signal())).items;
        expect(runs.map(({ id }) => id)).toEqual([runId]);
        expect(ok(await client.runs.list({ source: 'web' }, signal())).items).toEqual([]);
        expect(ok(await client.runs.list({ createdBy: 'member-owner' as never }, signal())).items).toEqual([]);
        expect(ok(await client.runs.list({ to: AT }, signal())).items).toEqual([]);
        expect(ok(await client.runs.stats({ agentId: AgentId.parse('other') }, signal())).running).toBe(0);
        expect(code(await client.runs.get(RunId.parse('nope'), signal()))).toBe('not-found');
        expect(code(await client.runs.cancel(RunId.parse('nope'), signal()))).toBe('not-found');
        expect(code(await client.runs.retry(RunId.parse('nope'), signal()))).toBe('not-found');
    });
});

describe('in-memory controller: triggers', () => {
    it('fires a schedule into a schedule run and counts it', async () => {
        const { client, controller } = engine();
        const agent = await agentIn(client);
        const trigger = await schedule(client, agent.id);
        const fire = controller.fireTrigger(trigger.id);
        expect(fire).toMatchObject({ outcome: 'started', error: null });
        const run = ok(await client.runs.get(RunId.parse(fire.runId ?? ''), signal()));
        expect(run).toMatchObject({ source: 'schedule', triggerId: trigger.id, status: 'queued', createdBy: null });
        const fired = ok(await client.triggers.get(trigger.id, signal()));
        expect(fired.lifecycle).toBe('active');
        expect(fired.lastFiredAt).toBe(fire.at);
        expect(fired.nextFireAt).not.toBeNull();
        if (fired.kind !== 'schedule') throw new Error('not a schedule');
        expect(fired.config.runCount).toBe(1);
        expect(ok(await client.runs.list({ triggerId: trigger.id }, signal())).items).toHaveLength(1);
    });

    it('ends a schedule at maxRunCount, and a one-off after its run', async () => {
        const { client, controller } = engine();
        const agent = await agentIn(client);
        const capped = await schedule(client, agent.id, { maxRunCount: 1 });
        controller.fireTrigger(capped.id);
        expect(ok(await client.triggers.get(capped.id, signal()))).toMatchObject({
            lifecycle: 'ended',
            endedReason: 'max-runs',
            nextFireAt: null,
        });
        const once = await schedule(client, agent.id, {
            name: 'Once',
            recurrence: { kind: 'once', at: '2026-10-20T08:00:00Z' },
        });
        expect(once.nextFireAt).toBe('2026-10-20T08:00:00.000Z');
        controller.fireTrigger(once.id);
        expect(ok(await client.triggers.get(once.id, signal()))).toMatchObject({
            lifecycle: 'ended',
            endedReason: 'completed',
        });
        expect(code(await client.triggers.resume(once.id, signal()))).toBe('trigger-ended');
        expect(code(await client.triggers.pause(once.id, signal()))).toBe('trigger-ended');
        expect(code(await client.triggers.update(once.id, { name: 'Again' }, signal()))).toBe('trigger-ended');
    });

    it('skips fires while paused and starts again after resume', async () => {
        const { client, controller } = engine();
        const agent = await agentIn(client);
        const trigger = await schedule(client, agent.id);
        const paused = ok(await client.triggers.pause(trigger.id, signal()));
        expect(paused).toMatchObject({ lifecycle: 'paused', nextFireAt: null });
        expect(ok(await client.triggers.pause(trigger.id, signal())).updatedAt).toBe(paused.updatedAt);
        expect(controller.fireTrigger(trigger.id)).toMatchObject({ outcome: 'skipped', runId: null });
        expect(ok(await client.runs.list({}, signal())).items).toEqual([]);
        const resumed = ok(await client.triggers.resume(trigger.id, signal()));
        expect(resumed.lifecycle).toBe('active');
        expect(resumed.nextFireAt).not.toBeNull();
        expect(ok(await client.triggers.resume(trigger.id, signal())).updatedAt).toBe(resumed.updatedAt);
        controller.fireTrigger(trigger.id);
        const fires = ok(await client.triggers.listFires(trigger.id, {}, signal())).items;
        expect(fires.map(({ outcome }) => outcome)).toEqual(['started', 'skipped']);
        const kinds = ok(await client.activity.list({ triggerId: trigger.id }, signal())).items.map((item) =>
            item.kind === 'known' ? item.activity.kind : item.kind,
        );
        expect(kinds).toEqual(['trigger.fired', 'trigger.resumed', 'trigger.paused']);
        expect(() => controller.fireTrigger('trigger-unknown')).toThrow();
    });

    it('starts an email run for an email trigger', async () => {
        const { client, controller } = engine();
        const agent = await agentIn(client);
        const trigger = ok(await client.triggers.create({ kind: 'email', agentId: agent.id, name: 'Inbox' }, signal()));
        expect(trigger).toMatchObject({
            kind: 'email',
            nextFireAt: null,
            config: { address: `${trigger.id}@engine.localhost` },
        });
        const fire = controller.fireTrigger(trigger.id);
        expect(ok(await client.runs.get(RunId.parse(fire.runId ?? ''), signal())).source).toBe('email');
        expect(ok(await client.triggers.get(trigger.id, signal())).lastFiredAt).toBe(fire.at);
    });

    it('validates updates against the trigger kind and the schedule', async () => {
        const { client } = engine();
        const agent = await agentIn(client);
        const email = ok(await client.triggers.create({ kind: 'email', agentId: agent.id, name: 'Inbox' }, signal()));
        const wrong = await client.triggers.update(email.id, { message: 'Hi' }, signal());
        expect(wrong.kind === 'problem' && wrong.problem.errors?.[0]?.path).toBe('body.message');
        expect(ok(await client.triggers.update(email.id, { name: 'Support' }, signal())).name).toBe('Support');
        const hourly = await schedule(client, agent.id);
        expect(
            code(
                await client.triggers.update(
                    hourly.id,
                    { recurrence: { kind: 'cron', expression: '99 * * * *', timeZone: 'UTC' } },
                    signal(),
                ),
            ),
        ).toBe('invalid-schedule');
        const moved = ok(
            await client.triggers.update(
                hourly.id,
                {
                    recurrence: { kind: 'cron', expression: '0 12 * * *', timeZone: 'UTC' },
                    startsAt: AT,
                    endsAt: '2027-01-01T00:00:00Z',
                    maxRunCount: 3,
                    message: 'Lunch',
                },
                signal(),
            ),
        );
        expect(moved.nextFireAt).toBe('2026-10-19T12:00:00.000Z');
        ok(await client.triggers.pause(hourly.id, signal()));
        expect(ok(await client.triggers.update(hourly.id, { message: 'Later' }, signal())).nextFireAt).toBeNull();
        expect(code(await client.triggers.update(TriggerId.parse('nope'), {}, signal()))).toBe('not-found');
    });

    it('refuses bad schedules and deleted agents on create', async () => {
        const { client } = engine();
        const agent = await agentIn(client);
        expect(
            code(
                await client.triggers.create(
                    {
                        kind: 'schedule',
                        agentId: agent.id,
                        name: 'Bad',
                        recurrence: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Nowhere/City' },
                        message: 'x',
                    },
                    signal(),
                ),
            ),
        ).toBe('invalid-schedule');
        ok(await client.agents.delete(agent.id, signal()));
        expect(code(await client.triggers.create({ kind: 'email', agentId: agent.id, name: 'x' }, signal()))).toBe(
            'agent-deleted',
        );
    });

    it('lists, filters and deletes triggers', async () => {
        const { client } = engine();
        const agent = await agentIn(client);
        const hourly = await schedule(client, agent.id);
        const email = ok(await client.triggers.create({ kind: 'email', agentId: agent.id, name: 'Inbox' }, signal()));
        expect(ok(await client.triggers.list({}, signal())).items.map(({ id }) => id)).toEqual([email.id, hourly.id]);
        expect(ok(await client.triggers.list({ kind: 'email' }, signal())).items.map(({ id }) => id)).toEqual([
            email.id,
        ]);
        expect(ok(await client.triggers.list({ lifecycle: 'paused' }, signal())).items).toEqual([]);
        expect(ok(await client.triggers.list({ agentId: AgentId.parse('other') }, signal())).items).toEqual([]);
        expect(ok(await client.triggers.delete(email.id, signal()))).toBeNull();
        expect(code(await client.triggers.get(email.id, signal()))).toBe('not-found');
        expect(code(await client.triggers.delete(email.id, signal()))).toBe('not-found');
        expect(code(await client.triggers.listFires(email.id, {}, signal()))).toBe('not-found');
        expect(code(await client.triggers.pause(email.id, signal()))).toBe('not-found');
    });
});

describe('in-memory controller: activity and events', () => {
    it('stamps appended activity from the clock and streams it', async () => {
        const { client, controller } = engine();
        const controllerAbort = new AbortController();
        const stream = ok(await client.events.stream({}, controllerAbort.signal));
        const appended = controller.appendActivity({
            kind: 'engine.update-available',
            agentId: null,
            actor: { kind: 'system' },
            version: '1.9.0',
        });
        expect(appended.id).toMatch(/^activity-/);
        expect(Date.parse(appended.at)).toBeGreaterThanOrEqual(Date.parse(AT));
        const [event] = await take(stream, 1);
        expect(event).toEqual({ type: 'activity', activity: { kind: 'known', activity: appended } });
        controllerAbort.abort();
        const listed = ok(await client.activity.list({ kind: 'engine.' }, signal()));
        expect(listed).toMatchObject({ dropped: 0, items: [{ kind: 'known', activity: appended }] });
        expect(ok(await client.activity.list({ kind: 'engine.updated' }, signal())).items).toEqual([]);
        expect(ok(await client.activity.list({ from: '2027-01-01T00:00:00Z' }, signal())).items).toEqual([]);
        expect(ok(await client.activity.list({ agentId: AgentId.parse('a') }, signal())).items).toEqual([]);
    });

    it('emits raw events and hides what the member may not read', async () => {
        const { client, controller } = engine({
            member: { id: 'member-limited', permissions: PERMISSIONS.filter((p) => p !== 'runs.read') },
        });
        const agent = await agentIn(client);
        const trigger = await schedule(client, agent.id);
        const abort = new AbortController();
        const stream = ok(await client.events.stream({}, abort.signal));
        controller.fireTrigger(trigger.id);
        controller.emit({ type: 'chat.changed', chatId: 'chat-elsewhere' });
        const events: ReadEngineEvent[] = await take(stream, 3);
        abort.abort();
        expect(
            events.map((event) =>
                event.type === 'activity' && event.activity.kind === 'known'
                    ? event.activity.activity.kind
                    : event.type,
            ),
        ).toEqual(['trigger.changed', 'trigger.fired', 'chat.changed']);
        expect(code(await client.runs.list({}, signal()))).toBe('forbidden');
        const visible = ok(await client.activity.list({}, signal())).items;
        expect(visible.some((item) => item.kind === 'known' && item.activity.kind.startsWith('run.'))).toBe(false);
        expect(visible).toHaveLength(1);
    });
});

describe('in-memory chat runs', () => {
    async function chatWith(options: InMemoryEngineApiOptions = {}) {
        const parts = engine(options);
        const agent = await agentIn(parts.client);
        const chat = ok(await parts.client.chats.create(agent.id, {}, signal()));
        const sent = ok(await parts.client.chats.sendMessage(chat.id, { content: 'hi' }, signal()));
        return { ...parts, chat, sent };
    }

    it('runs a chat reply as a web run that completes with the stream', async () => {
        const { client, chat, sent } = await chatWith({ replyScript: () => ({ chunks: ['ok'] }) });
        const [run] = ok(await client.runs.list({}, signal())).items;
        expect(run).toMatchObject({
            source: 'web',
            status: 'running',
            chatId: chat.id,
            messageId: sent.replyMessageId,
            createdBy: 'member-owner',
        });
        await drain(ok(await client.chats.streamReply(chat.id, sent.replyMessageId, {}, signal())));
        const detail = ok(await client.runs.get(RunId.parse(run?.id ?? ''), signal()));
        expect(detail.status).toBe('completed');
        expect(detail.outputs.messages).toEqual([{ chatId: chat.id, messageId: sent.replyMessageId }]);
    });

    it('fails the run with the reply', async () => {
        const { client, chat, sent } = await chatWith({ replyScript: () => ({ chunks: ['x'], outcome: 'failed' }) });
        await drain(ok(await client.chats.streamReply(chat.id, sent.replyMessageId, {}, signal())));
        const [run] = ok(await client.runs.list({}, signal())).items;
        expect(run).toMatchObject({ status: 'failed', error: { code: 'reply-failed' } });
    });

    it('cancels the run with the reply', async () => {
        const { client, chat, sent } = await chatWith();
        ok(await client.chats.cancelReply(chat.id, sent.replyMessageId, signal()));
        expect(ok(await client.runs.list({}, signal())).items[0]?.status).toBe('cancelled');
    });

    it('creates no runs and answers capability-not-supported without the capability', async () => {
        const { client } = await chatWith({ capabilities: [] });
        expect(ok(await client.engine.get(signal())).capabilities).toEqual([]);
        const refused = await client.runs.list({}, signal());
        expect(refused.kind === 'problem' && refused.problem).toMatchObject({
            status: 404,
            code: 'capability-not-supported',
        });
        expect(code(await client.files.list({}, signal()))).toBe('capability-not-supported');
        expect(ok(await client.activity.list({}, signal())).items).toEqual([]);
    });
});

describe('in-memory demo seed', () => {
    const demo = () =>
        createInMemoryEngine({
            seed: createDemoSeed(new Date('2026-10-19T12:00:00Z')),
            clock: steppingClock('2026-10-19T12:00:00Z'),
        });

    it('answers every list route with data', async () => {
        const { client } = demo();
        expect(ok(await client.agents.list({}, signal())).items).toHaveLength(3);
        expect(ok(await client.chats.listAll({ q: 'billing' }, signal())).items).toHaveLength(1);
        expect(ok(await client.chats.listAll({ agentId: AgentId.parse('agent-max') }, signal())).items).toEqual([]);
        expect(ok(await client.runs.list({}, signal())).items.length).toBeGreaterThanOrEqual(6);
        expect(ok(await client.runs.stats({}, signal()))).toMatchObject({ running: 1, queued: 1, failedLast24h: 1 });
        expect(ok(await client.files.list({ purpose: 'knowledge' }, signal())).items).toHaveLength(1);
        expect(
            ok(await client.files.list({ scan: 'infected', q: 'INVOICE', sort: 'name' }, signal())).items,
        ).toHaveLength(1);
        expect(
            ok(await client.files.list({ agentId: AgentId.parse('agent-iris'), sort: '-sizeBytes' }, signal())).items,
        ).toHaveLength(1);
        const versions = ok(await client.files.listVersions(FileId.parse('file-weekly-report'), {}, signal())).items;
        expect(versions.map(({ id }) => id)).toEqual(['version-report-42', 'version-report-41']);
        expect(ok(await client.files.get(FileId.parse('file-weekly-report'), signal())).versionCount).toBe(2);
        expect(ok(await client.triggers.list({}, signal())).items).toHaveLength(2);
        expect(
            ok(await client.triggers.listFires(TriggerId.parse('trigger-weekly-report'), {}, signal())).items,
        ).toHaveLength(1);
        expect(ok(await client.integrations.list({}, signal())).items).toHaveLength(3);
        const activity = ok(await client.activity.list({}, signal()));
        expect(activity.items.length).toBeGreaterThan(5);
        expect(activity.items.every((item) => item.kind === 'known')).toBe(true);
    });

    it('serves versions, refuses infected files and retries a failed run', async () => {
        const { client } = demo();
        expect(code(await client.files.download(FileId.parse('file-invoice-scan'), {}, signal()))).toBe(
            'file-infected',
        );
        const old = ok(
            await client.files.download(
                FileId.parse('file-weekly-report'),
                { version: FileVersionId.parse('version-report-41') },
                signal(),
            ),
        );
        expect(await old.text()).toBe('Week 41\n');
        expect(await ok(await client.files.download(FileId.parse('file-weekly-report'), {}, signal())).text()).toBe(
            'Week 42\n',
        );
        expect(
            code(
                await client.files.download(
                    FileId.parse('file-weekly-report'),
                    { version: FileVersionId.parse('nope') },
                    signal(),
                ),
            ),
        ).toBe('not-found');
        const run = ok(await client.runs.get(RunId.parse('run-iris-weekly'), signal()));
        expect(run.outputs.projectChanges[0]?.changedFiles[0]?.path).toBe('weekly/report.md');
        const retry = ok(await client.runs.retry(RunId.parse('run-iris-weekly-failed'), signal()));
        expect(retry).toMatchObject({
            status: 'queued',
            retryOf: 'run-iris-weekly-failed',
            triggerId: 'trigger-weekly-report',
        });
    });
});

describe('in-memory files', () => {
    it('uploads into an agent, versions and deletes with activity', async () => {
        const { client } = engine();
        const agent = await agentIn(client);
        const file = ok(
            await client.files.upload(
                {
                    file: new Blob(['hi'], { type: 'text/plain' }),
                    name: 'a.txt',
                    purpose: 'knowledge',
                    agentId: agent.id,
                },
                signal(),
            ),
        );
        expect(file).toMatchObject({
            agentId: agent.id,
            purpose: 'knowledge',
            scan: { status: 'clean' },
            versionCount: 1,
        });
        expect(ok(await client.files.listVersions(file.id, {}, signal())).items).toHaveLength(1);
        expect(
            code(
                await client.files.upload(
                    { file: new Blob(['x']), name: 'b', purpose: 'upload', agentId: AgentId.parse('nobody') },
                    signal(),
                ),
            ),
        ).toBe('validation-failed');
        ok(await client.files.delete(file.id, signal()));
        expect(code(await client.files.get(file.id, signal()))).toBe('not-found');
        expect(code(await client.files.listVersions(file.id, {}, signal()))).toBe('not-found');
        const kinds = ok(await client.activity.list({ kind: 'file.' }, signal())).items.map((item) =>
            item.kind === 'known' ? item.activity.kind : item.kind,
        );
        expect(kinds).toEqual(['file.deleted', 'file.created']);
    });
});

describe('in-memory integrations', () => {
    async function withSecrets() {
        const parts = engine();
        const { client } = parts;
        const ada = await agentIn(client, 'Ada');
        const bob = await agentIn(client, 'Bob');
        ok(await client.secrets.create({ name: 'TOKEN', scope: { kind: 'engine' }, value: 'v' }, signal()));
        ok(
            await client.secrets.create(
                { name: 'BOB_KEY', scope: { kind: 'agent', agentId: bob.id }, value: 'v' },
                signal(),
            ),
        );
        const revoked = ok(
            await client.secrets.create({ name: 'OLD', scope: { kind: 'engine' }, value: 'v' }, signal()),
        );
        ok(await client.secrets.revoke(revoked.id, signal()));
        return { ...parts, ada, bob };
    }

    it('resolves secrets by name and scope', async () => {
        const { client, ada } = await withSecrets();
        const healthy = ok(
            await client.integrations.create(
                {
                    kind: 'mcp-server',
                    name: 'Docs',
                    agentId: ada.id,
                    url: 'https://docs.example.com/mcp',
                    secretNames: ['TOKEN'],
                },
                signal(),
            ),
        );
        expect(healthy).toMatchObject({
            status: 'connected',
            statusDetail: null,
            secretRefs: [{ name: 'TOKEN', state: 'resolved' }],
        });
        const broken = ok(
            await client.integrations.create(
                {
                    kind: 'repository',
                    name: 'Repo',
                    agentId: ada.id,
                    provider: 'github',
                    repository: 'acme/app',
                    secretNames: ['BOB_KEY', 'OLD'],
                },
                signal(),
            ),
        );
        expect(broken.status).toBe('needs-attention');
        expect(broken.secretRefs.map(({ name, state }) => [name, state])).toEqual([
            ['BOB_KEY', 'missing'],
            ['OLD', 'revoked'],
        ]);
        expect(broken.statusDetail).toContain('BOB_KEY');
        const kinds = ok(await client.activity.list({ kind: 'integration.' }, signal())).items.map((item) =>
            item.kind === 'known' ? item.activity.kind : item.kind,
        );
        expect(kinds).toEqual(['integration.error', 'integration.connected']);
        expect(ok(await client.integrations.list({ status: 'connected' }, signal())).items).toHaveLength(1);
        expect(
            ok(await client.integrations.list({ kind: 'repository', agentId: ada.id }, signal())).items,
        ).toHaveLength(1);
    });

    it('refuses duplicate names, foreign fields and deleted agents', async () => {
        const { client, ada, bob } = await withSecrets();
        const mcp = ok(
            await client.integrations.create(
                { kind: 'mcp-server', name: 'Docs', url: 'https://a.example.com' },
                signal(),
            ),
        );
        expect(mcp.agentId).toBeNull();
        expect(
            code(
                await client.integrations.create(
                    { kind: 'mcp-server', name: 'Docs', url: 'https://b.example.com' },
                    signal(),
                ),
            ),
        ).toBe('name-taken');
        const repo = ok(
            await client.integrations.create(
                { kind: 'repository', name: 'Repo', provider: 'github', repository: 'acme/app' },
                signal(),
            ),
        );
        expect(code(await client.integrations.update(repo.id, { name: 'Docs' }, signal()))).toBe('name-taken');
        expect(code(await client.integrations.update(repo.id, { url: 'https://x.example.com' }, signal()))).toBe(
            'validation-failed',
        );
        const moved = ok(
            await client.integrations.update(mcp.id, { url: 'https://c.example.com', name: 'Search' }, signal()),
        );
        expect(moved.kind === 'mcp-server' && moved.config.url).toBe('https://c.example.com');
        ok(await client.agents.delete(bob.id, signal()));
        expect(
            code(
                await client.integrations.create(
                    { kind: 'mcp-server', name: 'X', agentId: bob.id, url: 'https://x.example.com' },
                    signal(),
                ),
            ),
        ).toBe('agent-deleted');
        expect(ada.id).toBeDefined();
    });

    it('disables, enables and checks idempotently', async () => {
        const { client } = await withSecrets();
        const mcp = ok(
            await client.integrations.create(
                { kind: 'mcp-server', name: 'Docs', url: 'https://a.example.com', secretNames: ['TOKEN'] },
                signal(),
            ),
        );
        const disabled = ok(await client.integrations.disable(mcp.id, signal()));
        expect(disabled.status).toBe('disconnected');
        expect(ok(await client.integrations.disable(mcp.id, signal())).updatedAt).toBe(disabled.updatedAt);
        expect(ok(await client.integrations.check(mcp.id, signal())).status).toBe('disconnected');
        const renamed = ok(await client.integrations.update(mcp.id, { secretNames: ['MISSING'] }, signal()));
        expect(renamed).toMatchObject({ status: 'disconnected', secretRefs: [{ name: 'MISSING', state: 'missing' }] });
        expect(ok(await client.integrations.enable(mcp.id, signal())).status).toBe('needs-attention');
        ok(await client.integrations.update(mcp.id, { secretNames: ['TOKEN'] }, signal()));
        expect(ok(await client.integrations.get(mcp.id, signal())).status).toBe('connected');
        expect(ok(await client.integrations.enable(mcp.id, signal())).status).toBe('connected');
        expect(ok(await client.integrations.check(mcp.id, signal())).status).toBe('connected');
        expect(ok(await client.integrations.delete(mcp.id, signal()))).toBeNull();
        for (const call of [
            client.integrations.get(mcp.id, signal()),
            client.integrations.enable(mcp.id, signal()),
            client.integrations.disable(mcp.id, signal()),
            client.integrations.check(mcp.id, signal()),
            client.integrations.update(mcp.id, {}, signal()),
            client.integrations.delete(IntegrationId.parse('nope'), signal()),
        ]) {
            expect(code(await call)).toBe('not-found');
        }
    });

    it('starts the calendar OAuth flow on a same-origin path', async () => {
        const { client } = engine();
        const started = ok(await client.integrations.connectCalendar({ provider: 'google' }, signal()));
        expect(started.redirectPath.startsWith('/')).toBe(true);
        expect(started.redirectPath.startsWith('//')).toBe(false);
    });
});
