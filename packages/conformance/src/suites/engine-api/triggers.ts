import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { Trigger } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, fail, skip } from '../../check';
import { CHAT_MESSAGE } from '../../fixtures/books';
import { checkFilter, checkStableWalk, requireCapability } from './capability-support';
import { SUITE, attempt } from './support';
import type { World } from './world';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;
const YEAR_MS = 365 * 24 * 3600 * 1000;
const CREATED = 5;

/** A one-off schedule a year ahead, so it never fires while the suite runs. */
async function createSchedule(world: World, label: string): Promise<Trigger> {
    const { id: agentId } = await world.agent();
    const trigger = await world.owner.ok(R.createTrigger, {
        body: {
            kind: 'schedule',
            agentId,
            name: world.name(label),
            recurrence: { kind: 'once', at: new Date(Date.now() + YEAR_MS).toISOString() },
            message: CHAT_MESSAGE,
        },
    });
    world.ctx.resources.defer((signal) =>
        world.owner.withSignal(signal).send(R.deleteTrigger, { params: { triggerId: trigger.id } }),
    );
    return trigger;
}

/** What a pause or resume may change; a repeated one must change none of it. */
const stateOf = ({ lifecycle, endedReason, nextFireAt, updatedAt }: Trigger) =>
    JSON.stringify({ lifecycle, endedReason, nextFireAt, updatedAt });

export const TRIGGER_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.triggers.paging',
        suite: SUITE,
        title: 'GET /triggers pages without gaps or duplicates, and its filters list only matching triggers',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.triggers);
            const findings = new Findings();
            const created: string[] = [];
            for (let index = 0; index < CREATED; index++) created.push((await createSchedule(world, 'page')).id);
            const { id: agentId } = await world.agent();
            await attempt(findings, () => checkStableWalk(world, findings, R.listTriggers, { agentId }));
            await attempt(findings, async () => {
                const listed = await world.owner.ok(R.listTriggers, { query: { agentId, limit: 100 } });
                const missing = created.filter((id) => !listed.items.some((trigger) => trigger.id === id));
                if (missing.length > 0)
                    findings.add(`GET /triggers: ${String(missing.length)} created triggers are missing`);
                checkFilter(
                    findings,
                    R.listTriggers,
                    'agentId',
                    listed.items,
                    (trigger) => trigger.agentId === agentId,
                );
                const schedules = await world.owner.ok(R.listTriggers, { query: { kind: 'schedule', limit: 50 } });
                checkFilter(
                    findings,
                    R.listTriggers,
                    'kind=schedule',
                    schedules.items,
                    ({ kind }) => kind === 'schedule',
                );
                const active = await world.owner.ok(R.listTriggers, { query: { lifecycle: 'active', limit: 50 } });
                checkFilter(
                    findings,
                    R.listTriggers,
                    'lifecycle=active',
                    active.items,
                    (trigger) => trigger.lifecycle === 'active',
                );
            });
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.triggers.pause-resume-idempotent',
        suite: SUITE,
        title: 'Pausing or resuming twice is one change; resuming an ended trigger is 409 trigger-ended',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.triggers);
            const findings = new Findings();
            const trigger = await createSchedule(world, 'pause');
            const params = { triggerId: trigger.id };
            const paused = await world.owner.ok(R.pauseTrigger, { params });
            if (paused.lifecycle !== 'paused')
                findings.add(`POST /triggers/{triggerId}/pause: lifecycle is ${paused.lifecycle}`);
            if (paused.nextFireAt !== null)
                findings.add('POST /triggers/{triggerId}/pause: a paused trigger has a next fire');
            await attempt(findings, async () => {
                const again = await world.owner.ok(R.pauseTrigger, { params });
                if (stateOf(again) !== stateOf(paused))
                    fail('POST /triggers/{triggerId}/pause: pausing twice changed it again');
            });
            const resumed = await world.owner.ok(R.resumeTrigger, { params });
            if (resumed.lifecycle !== 'active')
                findings.add(`POST /triggers/{triggerId}/resume: lifecycle is ${resumed.lifecycle}`);
            await attempt(findings, async () => {
                const again = await world.owner.ok(R.resumeTrigger, { params });
                if (stateOf(again) !== stateOf(resumed))
                    fail('POST /triggers/{triggerId}/resume: resuming twice changed it again');
            });
            const [ended] = (await world.owner.ok(R.listTriggers, { query: { lifecycle: 'ended', limit: 1 } })).items;
            if (ended === undefined) {
                if (findings.count === 0) skip('the engine lists no ended trigger to try resuming');
            } else {
                await attempt(findings, async () => {
                    await world.owner.problem(R.resumeTrigger, { params: { triggerId: ended.id } }, 'trigger-ended');
                    const after = await world.owner.ok(R.getTrigger, { params: { triggerId: ended.id } });
                    if (after.lifecycle !== 'ended')
                        fail('POST /triggers/{triggerId}/resume: a refused resume changed it');
                });
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.triggers.invalid-schedule',
        suite: SUITE,
        title: 'A schedule the engine cannot run (bad cron, unknown time zone, end before start) is 422 invalid-schedule',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.triggers);
            const findings = new Findings();
            const { id: agentId } = await world.agent();
            const now = Date.now();
            const bodies = [
                { recurrence: { kind: 'cron', expression: '61 25 * * *', timeZone: 'UTC' } },
                { recurrence: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Mars/Olympus_Mons' } },
                {
                    recurrence: { kind: 'interval', everySeconds: 3600 },
                    startsAt: new Date(now + YEAR_MS).toISOString(),
                    endsAt: new Date(now + YEAR_MS / 2).toISOString(),
                },
            ];
            for (const fields of bodies) {
                await attempt(findings, async () => {
                    const body = {
                        kind: 'schedule',
                        agentId,
                        name: world.name('invalid'),
                        message: CHAT_MESSAGE,
                        ...fields,
                    };
                    const result = await world.owner.call(R.createTrigger, { body });
                    if (result.kind === 'ok') {
                        ctx.resources.defer((signal) =>
                            world.owner
                                .withSignal(signal)
                                .send(R.deleteTrigger, { params: { triggerId: result.data.id } }),
                        );
                        fail(`POST /triggers: accepted ${JSON.stringify(fields.recurrence)}`);
                    }
                    if (result.problem.code !== 'invalid-schedule') {
                        fail(`POST /triggers: got ${result.problem.code}, not invalid-schedule`);
                    }
                });
            }
            return findings.outcome();
        },
    },
];
