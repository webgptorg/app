import type { RunSource } from '../capabilities/runs';
import type { ScheduleConfig, Trigger, TriggerFire } from '../capabilities/triggers';
import { Timestamp, TriggerFireId, TriggerId } from '../common';
import { fail, invalid, liveAgent, memberActor, notFound, ok, page, recordActivity, sortBy, time } from './kit';
import type { EngineContext, HandlerContext, Handlers, HandlerResult } from './kit';
import { queueRun } from './runs';
import { nextFireAt, scheduleProblem } from './schedule';
import type { TriggerRecord } from './state';

const EPOCH = '1970-01-01T00:00:00Z';

function next(config: ScheduleConfig, now: string, lastFiredAt: string | null): Timestamp | null {
    const at = nextFireAt(config, now, lastFiredAt);
    return at === null ? null : Timestamp.parse(at);
}

function save(ctx: EngineContext, record: TriggerRecord, trigger: Trigger): Trigger {
    record.trigger = trigger;
    ctx.publish({ type: 'trigger.changed', triggerId: trigger.id, agentId: trigger.agentId });
    return trigger;
}

function found(ctx: EngineContext, triggerId: string): HandlerResult<TriggerRecord> {
    const record = ctx.state.triggers.get(triggerId);
    return record ? ok(record) : notFound('trigger');
}

const SOURCE: Readonly<Record<Trigger['kind'], RunSource>> = {
    email: 'email',
    schedule: 'schedule',
    webhook: 'webhook',
};

/**
 * What the engine does when a trigger fires: a schedule comes due or an email arrives. An inactive trigger records a
 * skipped fire; an active one queues a run and, for schedules, counts it and works out the next fire.
 */
export function fireTrigger(ctx: EngineContext, triggerId: string): TriggerFire {
    const record = ctx.state.triggers.get(triggerId);
    if (!record) throw new Error(`No trigger ${triggerId}`);
    const trigger = record.trigger;
    const now = ctx.now();
    if (trigger.lifecycle !== 'active') {
        const skipped: TriggerFire = {
            id: ctx.newId(TriggerFireId, 'fire'),
            at: now,
            outcome: 'skipped',
            runId: null,
            error: null,
        };
        record.fires.push(skipped);
        return skipped;
    }
    const actor = { kind: 'trigger', triggerId: trigger.id } as const;
    const run = queueRun(ctx, {
        agentId: trigger.agentId,
        source: SOURCE[trigger.kind],
        triggerId: trigger.id,
        createdBy: null,
        actor,
    });
    const fire: TriggerFire = {
        id: ctx.newId(TriggerFireId, 'fire'),
        at: now,
        outcome: 'started',
        runId: run.id,
        error: null,
    };
    record.fires.push(fire);
    let updated: Trigger = { ...trigger, lastFiredAt: now, updatedAt: now };
    if (updated.kind === 'schedule') {
        const config = { ...updated.config, runCount: updated.config.runCount + 1 };
        const nextFire = next(config, now, now);
        const reachedMax = config.maxRunCount !== null && config.runCount >= config.maxRunCount;
        updated = {
            ...updated,
            config,
            nextFireAt: nextFire,
            ...(nextFire === null
                ? {
                      lifecycle: 'ended' as const,
                      endedReason: reachedMax ? ('max-runs' as const) : ('completed' as const),
                  }
                : {}),
        };
    }
    save(ctx, record, updated);
    recordActivity(ctx, {
        kind: 'trigger.fired',
        agentId: trigger.agentId,
        actor,
        triggerId: trigger.id,
        name: trigger.name,
        runId: run.id,
    });
    return fire;
}

function setLifecycle(ctx: HandlerContext, triggerId: string, lifecycle: 'paused' | 'active'): HandlerResult<Trigger> {
    const result = found(ctx, triggerId);
    if (result.kind === 'problem') return result;
    const record = result.data;
    const trigger = record.trigger;
    if (trigger.lifecycle === 'ended') return fail('trigger-ended');
    if (trigger.lifecycle === lifecycle) return ok(trigger);
    const now = ctx.now();
    const nextFire =
        lifecycle === 'paused' || trigger.kind !== 'schedule' ? null : next(trigger.config, now, trigger.lastFiredAt);
    const updated = save(ctx, record, { ...trigger, lifecycle, nextFireAt: nextFire, updatedAt: now });
    recordActivity(ctx, {
        kind: lifecycle === 'paused' ? 'trigger.paused' : 'trigger.resumed',
        agentId: trigger.agentId,
        actor: memberActor(ctx),
        triggerId: trigger.id,
        name: trigger.name,
    });
    return ok(updated);
}

export const TRIGGER_HANDLERS: Pick<
    Handlers,
    | 'listTriggers'
    | 'createTrigger'
    | 'getTrigger'
    | 'updateTrigger'
    | 'deleteTrigger'
    | 'pauseTrigger'
    | 'resumeTrigger'
    | 'listTriggerFires'
> = {
    listTriggers: ({ query }, ctx) => {
        const triggers = [...ctx.state.triggers.values()]
            .map(({ trigger }) => trigger)
            .filter(
                (trigger) =>
                    (query.agentId === undefined || trigger.agentId === query.agentId) &&
                    (query.kind === undefined || trigger.kind === query.kind) &&
                    (query.lifecycle === undefined || trigger.lifecycle === query.lifecycle),
            );
        return page(
            triggers,
            sortBy('-createdAt', (trigger) => time(trigger.createdAt), true),
            query,
        );
    },
    createTrigger: ({ body }, ctx) => {
        const agent = liveAgent(ctx, body.agentId);
        if (agent.kind === 'problem') return agent;
        const now = ctx.now();
        const id = ctx.newId(TriggerId, 'trigger');
        const base = {
            id,
            agentId: body.agentId,
            name: body.name,
            lifecycle: 'active' as const,
            endedReason: null,
            lastFiredAt: null,
            createdBy: ctx.member.id,
            createdAt: now,
            updatedAt: now,
        };
        let trigger: Trigger;
        if (body.kind === 'email') {
            trigger = {
                ...base,
                kind: 'email',
                nextFireAt: null,
                config: { address: `${id}@${ctx.state.engine.hostname}` },
            };
        } else {
            const startsAt = body.startsAt ?? now;
            const config: ScheduleConfig = {
                recurrence: body.recurrence,
                startsAt,
                endsAt: body.endsAt ?? null,
                maxRunCount: body.maxRunCount ?? null,
                runCount: 0,
                message: body.message,
            };
            const problem = scheduleProblem(config.recurrence, config.startsAt, config.endsAt, now);
            if (problem !== undefined) return fail('invalid-schedule', { detail: problem });
            trigger = { ...base, kind: 'schedule', nextFireAt: next(config, now, null), config };
        }
        ctx.state.triggers.set(id, { trigger, fires: [] });
        ctx.publish({ type: 'trigger.changed', triggerId: id, agentId: trigger.agentId });
        return ok(trigger);
    },
    getTrigger: ({ params }, ctx) => {
        const result = found(ctx, params.triggerId);
        return result.kind === 'problem' ? result : ok(result.data.trigger);
    },
    updateTrigger: ({ params, body }, ctx) => {
        const result = found(ctx, params.triggerId);
        if (result.kind === 'problem') return result;
        const record = result.data;
        const trigger = record.trigger;
        if (trigger.lifecycle === 'ended') return fail('trigger-ended');
        const now = ctx.now();
        const named = { ...trigger, ...(body.name === undefined ? {} : { name: body.name }), updatedAt: now };
        if (named.kind !== 'schedule') {
            const field = Object.keys(body).find((key) => key !== 'name');
            if (field !== undefined) return invalid(`body.${field}`, 'Only schedule triggers have this field.');
            return ok(save(ctx, record, named));
        }
        const config: ScheduleConfig = {
            ...named.config,
            ...(body.recurrence === undefined ? {} : { recurrence: body.recurrence }),
            ...(body.startsAt === undefined ? {} : { startsAt: body.startsAt }),
            ...(body.endsAt === undefined ? {} : { endsAt: body.endsAt }),
            ...(body.maxRunCount === undefined ? {} : { maxRunCount: body.maxRunCount }),
            ...(body.message === undefined ? {} : { message: body.message }),
        };
        // Only a new one-off time must lie in the future; an unchanged one may be overdue already.
        const problem = scheduleProblem(
            config.recurrence,
            config.startsAt,
            config.endsAt,
            body.recurrence ? now : EPOCH,
        );
        if (problem !== undefined) return fail('invalid-schedule', { detail: problem });
        const nextFire = named.lifecycle === 'active' ? next(config, now, named.lastFiredAt) : named.nextFireAt;
        return ok(save(ctx, record, { ...named, config, nextFireAt: nextFire }));
    },
    deleteTrigger: ({ params }, ctx) => {
        const result = found(ctx, params.triggerId);
        if (result.kind === 'problem') return result;
        ctx.state.triggers.delete(params.triggerId);
        ctx.publish({ type: 'trigger.changed', triggerId: params.triggerId, agentId: result.data.trigger.agentId });
        return ok(null);
    },
    pauseTrigger: ({ params }, ctx) => setLifecycle(ctx, params.triggerId, 'paused'),
    resumeTrigger: ({ params }, ctx) => setLifecycle(ctx, params.triggerId, 'active'),
    listTriggerFires: ({ params, query }, ctx) => {
        const result = found(ctx, params.triggerId);
        if (result.kind === 'problem') return result;
        const order = new Map(result.data.fires.map((fire, index) => [fire.id, index]));
        return page(
            result.data.fires,
            sortBy('newest', (fire) => order.get(fire.id) ?? 0, true),
            query,
        );
    },
};
