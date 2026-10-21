import type { EngineApiClient, EngineApiResponse, EngineApiRouteId, ReadEngineEvent } from '@ptbk/engine-api';
import { ENGINE_API_PREFIX, ENGINE_API_ROUTE_LIST, ENGINE_API_ROUTES } from '@ptbk/engine-api';
import { afterEach, describe, expect, it } from 'vitest';

import type { ApiHarness } from '../src/testing/api-harness';
import { HARNESS_ORIGIN, createApiHarness } from '../src/testing/api-harness';

const signal = () => AbortSignal.timeout(10_000);
const harnesses: ApiHarness[] = [];

afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
        await harness.recorder.settled();
        expect(harness.recorder.violations).toEqual([]);
        await harness.close();
    }
});

async function start(options: Parameters<typeof createApiHarness>[0] = {}) {
    const harness = await createApiHarness(options);
    harnesses.push(harness);
    const owner = harness.client(harness.signIn({ memberId: harness.ownerId() }));
    return { harness, owner };
}

describe('capabilities through the mock HTTP server (contract)', () => {
    it('answers every C-07 operation, each response valid against its strict schema', async () => {
        const { harness, owner } = await start();
        const answered = new Set<EngineApiRouteId>();
        const okFrom = async <T>(id: EngineApiRouteId, response: Promise<EngineApiResponse<T>>): Promise<T> => {
            const result = await response;
            if (result.kind !== 'ok') throw new Error(`${id}: ${result.problem.code}`);
            answered.add(id);
            return result.data;
        };
        const controller = harness.core().controller;
        const [agent] = controller.findAgents();
        if (agent === undefined) throw new Error('no agent');

        const runs = await okFrom('listRuns', owner.runs.list({ status: 'failed', limit: 5 }, signal()));
        await okFrom('getRunStats', owner.runs.stats({}, signal()));
        const failed = runs.items[0];
        if (failed === undefined) throw new Error('no failed run');
        await okFrom('getRun', owner.runs.get(failed.id, signal()));
        const retry = await okFrom('retryRun', owner.runs.retry(failed.id, signal()));
        await okFrom('cancelRun', owner.runs.cancel(retry.id, signal()));

        const upload = await okFrom(
            'uploadFile',
            owner.files.upload(
                { file: new Blob(['notes\n'], { type: 'text/plain' }), name: 'notes.txt', purpose: 'upload' },
                signal(),
            ),
        );
        await okFrom('listFiles', owner.files.list({ purpose: 'knowledge', limit: 5 }, signal()));
        await okFrom('getFile', owner.files.get(upload.id, signal()));
        const [version] = (await okFrom('listFileVersions', owner.files.listVersions(upload.id, {}, signal()))).items;
        const content = await okFrom(
            'downloadFile',
            owner.files.download(upload.id, version === undefined ? {} : { version: version.id }, signal()),
        );
        expect(await content.text()).toBe('notes\n');
        await okFrom('deleteFile', owner.files.delete(upload.id, signal()));

        const trigger = await okFrom(
            'createTrigger',
            owner.triggers.create(
                {
                    kind: 'schedule',
                    agentId: agent.id,
                    name: 'Contract schedule',
                    recurrence: { kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Europe/Prague' },
                    message: 'Report',
                },
                signal(),
            ),
        );
        await okFrom('listTriggers', owner.triggers.list({ kind: 'schedule', limit: 5 }, signal()));
        await okFrom('getTrigger', owner.triggers.get(trigger.id, signal()));
        await okFrom('updateTrigger', owner.triggers.update(trigger.id, { name: 'Renamed schedule' }, signal()));
        await okFrom('pauseTrigger', owner.triggers.pause(trigger.id, signal()));
        await okFrom('resumeTrigger', owner.triggers.resume(trigger.id, signal()));
        const [email] = controller.findTriggers({ kind: 'email' });
        await okFrom('listTriggerFires', owner.triggers.listFires(email?.id ?? trigger.id, {}, signal()));
        await okFrom('deleteTrigger', owner.triggers.delete(trigger.id, signal()));

        const integration = await okFrom(
            'createIntegration',
            owner.integrations.create(
                { kind: 'repository', name: 'Contract repo', provider: 'github', repository: 'acme/contract' },
                signal(),
            ),
        );
        await okFrom('listIntegrations', owner.integrations.list({ status: 'connected', limit: 5 }, signal()));
        await okFrom('getIntegration', owner.integrations.get(integration.id, signal()));
        await okFrom(
            'updateIntegration',
            owner.integrations.update(integration.id, { name: 'Renamed repo' }, signal()),
        );
        await okFrom('disableIntegration', owner.integrations.disable(integration.id, signal()));
        await okFrom('enableIntegration', owner.integrations.enable(integration.id, signal()));
        await okFrom('checkIntegration', owner.integrations.check(integration.id, signal()));
        await okFrom('deleteIntegration', owner.integrations.delete(integration.id, signal()));
        await okFrom('connectCalendar', owner.integrations.connectCalendar({ provider: 'google' }, signal()));

        await okFrom('listActivity', owner.activity.list({ kind: 'run.', limit: 20 }, signal()));

        const capabilityRoutes = ENGINE_API_ROUTE_LIST.filter((route) => route.capability !== undefined).map(
            ({ id }) => id,
        );
        expect([...answered].filter((id) => id !== 'listActivity').sort()).toEqual([...capabilityRoutes].sort());
    });

    it('serves only runs@1 with MOCK_CAPABILITIES=runs, and 404 capability-not-supported for the rest', async () => {
        const { harness, owner } = await start({ capabilities: ['runs'] });
        const engine = await owner.engine.get(signal());
        expect(engine.kind === 'ok' && engine.data.capabilities).toEqual([{ id: 'runs', version: 1 }]);
        const cookie = harness.signIn({ memberId: harness.ownerId() });
        for (const route of ENGINE_API_ROUTE_LIST) {
            if (route.capability === undefined) continue;
            const path = route.path.replace(/\{\w+\}/g, 'conformance-x');
            const response = await harness.fetch(cookie)(`${HARNESS_ORIGIN}${ENGINE_API_PREFIX}${path}`, {
                method: route.method,
                ...(route.body?.kind === 'json'
                    ? { headers: { 'content-type': 'application/json' }, body: '{}' }
                    : route.body?.kind === 'multipart'
                      ? { body: new FormData() }
                      : {}),
            });
            const body = (await response.json()) as { code?: string };
            if (route.capability.id === 'runs') expect(body.code, route.id).not.toBe('capability-not-supported');
            else expect([response.status, body.code], route.id).toEqual([404, 'capability-not-supported']);
        }
        expect(ok(await owner.runs.list({ limit: 1 }, signal())).items).toHaveLength(1);
    });
});

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got ${response.problem.code}`);
    return response.data;
}

async function subscribe(client: EngineApiClient, lastEventId?: string) {
    const abort = new AbortController();
    const items = ok(await client.events.stream(lastEventId === undefined ? {} : { lastEventId }, abort.signal));
    const iterator = items[Symbol.asyncIterator]();
    return {
        async take(count: number, keep: (event: ReadEngineEvent) => boolean) {
            const taken: { id: string | null; event: ReadEngineEvent }[] = [];
            while (taken.length < count) {
                const next = await iterator.next();
                if (next.done === true) throw new Error('stream ended');
                if (keep(next.value.event)) taken.push(next.value);
            }
            return taken;
        },
        close: () => {
            abort.abort();
        },
    };
}

describe('capability events', () => {
    const aboutRun = (runId: string) => (event: ReadEngineEvent) =>
        (event.type === 'run.changed' && event.runId === runId) ||
        (event.type === 'activity' &&
            event.activity.kind === 'known' &&
            'runId' in event.activity.activity &&
            event.activity.activity.runId === runId);
    const describeEvent = (event: ReadEngineEvent): string =>
        event.type === 'run.changed'
            ? `run.changed:${event.status}`
            : event.type === 'activity' && event.activity.kind === 'known'
              ? event.activity.activity.kind
              : event.type;

    it('streams run progress as run.changed and activity, in order, hidden from a member without runs.read', async () => {
        const { harness, owner } = await start();
        const blind = harness.client(
            harness.signIn({ memberId: harness.ownerId(), permissions: ['agents.read', 'chats.read'] }),
        );
        const [agent] = harness.core().controller.findAgents();
        if (agent === undefined) throw new Error('no agent');
        const ownerEvents = await subscribe(owner);
        const blindEvents = await subscribe(blind);
        const run = harness.runtime?.simulation().scriptRun({
            agentId: agent.id,
            source: 'api',
            outcome: 'completed',
            steps: [{ text: 'Only step' }],
        });
        if (run === undefined) throw new Error('no runtime');
        harness.runtime?.clock.advance(10_000);
        const seen = await ownerEvents.take(8, aboutRun(run.id));
        expect(seen.map(({ event }) => describeEvent(event))).toEqual([
            'run.changed:queued',
            'run.queued',
            'run.changed:running',
            'run.started',
            'run.changed:running',
            'run.changed:running',
            'run.changed:completed',
            'run.completed',
        ]);
        const ids = seen.map(({ id }) => Number(id));
        expect([...ids].sort((a, b) => a - b)).toEqual(ids);
        // Something the member may see, after everything about the run: none of the run's events came first.
        ok(await owner.chats.create(agent.id, { title: 'After the run' }, signal()));
        const [first] = await blindEvents.take(1, () => true);
        expect(first?.event.type).toBe('chat.changed');
        ownerEvents.close();
        blindEvents.close();
    });

    it('replays the run events missed while disconnected after Last-Event-ID', async () => {
        const { harness, owner } = await start();
        const [agent] = harness.core().controller.findAgents();
        if (agent === undefined) throw new Error('no agent');
        const first = await subscribe(owner);
        const run = harness.runtime?.simulation().scriptRun({
            agentId: agent.id,
            source: 'api',
            outcome: 'failed',
            steps: [{ text: 'Try', toolName: 'web.fetch' }],
        });
        if (run === undefined) throw new Error('no runtime');
        const [queued] = await first.take(1, aboutRun(run.id));
        first.close();
        harness.runtime?.clock.advance(30_000);
        const resumed = await subscribe(owner, queued?.id ?? undefined);
        const replayed = await resumed.take(2, () => true);
        expect(replayed.map(({ id }) => Number(id))).toEqual([Number(queued?.id) + 1, Number(queued?.id) + 2]);
        expect(replayed.map(({ event }) => describeEvent(event))).toEqual(['run.queued', 'run.changed:running']);
        const rest = await resumed.take(1, (event) => event.type === 'run.changed' && event.status === 'failed');
        expect(rest).toHaveLength(1);
        resumed.close();
    });
});

describe('capability faults', () => {
    it('finds the next upload infected under scanInfectedRate, so it cannot be downloaded', async () => {
        const { harness, owner } = await start();
        const clean = ok(
            await owner.files.upload({ file: new Blob(['a']), name: 'clean.txt', purpose: 'upload' }, signal()),
        );
        expect(clean.scan.status).toBe('clean');
        harness.faults.set({ ...harness.faults.plan(), scanInfectedRate: 1 });
        const infected = ok(
            await owner.files.upload({ file: new Blob(['b']), name: 'infected.txt', purpose: 'upload' }, signal()),
        );
        expect(infected.scan.status).toBe('infected');
        expect(await owner.files.download(infected.id, {}, signal())).toMatchObject({
            kind: 'problem',
            problem: { status: 409, code: 'file-infected' },
        });
    });

    it('fails the next connection test under integrationErrorRate', async () => {
        const { harness, owner } = await start();
        const integration = ok(
            await owner.integrations.create(
                { kind: 'mcp-server', name: 'Flaky', url: 'https://mcp.flaky.example.com/sse' },
                signal(),
            ),
        );
        expect(integration.status).toBe('connected');
        harness.faults.set({ ...harness.faults.plan(), integrationErrorRate: 1 });
        expect(ok(await owner.integrations.check(integration.id, signal()))).toMatchObject({
            status: 'error',
            statusDetail: 'Connection to mcp.flaky.example.com timed out after 10 s.',
        });
        expect(ENGINE_API_ROUTES.checkIntegration.permission).toBe('integrations.manage');
    });
});
