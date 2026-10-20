import type { ActivityActor } from '../capabilities/activity';
import { Run, TERMINAL_RUN_STATUSES } from '../capabilities/runs';
import type { RunDetail, RunError, RunSource, RunUsage } from '../capabilities/runs';
import { stripUnknownFields } from '../tolerant';
import type { AgentId, ChatId, MemberId, MessageId, TriggerId } from '../common';
import { RunId } from '../common';
import { fail, notFound, ok, page, recordActivity, sortParam, time, within } from './kit';
import type { EngineContext, Handlers, HandlerResult } from './kit';

const DAY_MS = 24 * 3600 * 1000;

/** A run as lists show it: the detail without tool calls, outputs and report. */
export function runSummary(detail: RunDetail): Run {
    return Run.parse(stripUnknownFields(Run, detail));
}

function save(ctx: EngineContext, detail: RunDetail): Run {
    ctx.state.runs.set(detail.id, detail);
    ctx.publish({ type: 'run.changed', runId: detail.id, agentId: detail.agentId, status: detail.status });
    return runSummary(detail);
}

export interface NewRun {
    readonly agentId: AgentId;
    readonly source: RunSource;
    readonly chatId?: ChatId;
    readonly messageId?: MessageId;
    readonly triggerId?: TriggerId;
    readonly retryOf?: RunId;
    readonly createdBy: MemberId | null;
    readonly actor: ActivityActor;
}

export function queueRun(ctx: EngineContext, input: NewRun): RunDetail {
    const detail: RunDetail = {
        id: ctx.newId(RunId, 'run'),
        agentId: input.agentId,
        source: input.source,
        status: 'queued',
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        triggerId: input.triggerId ?? null,
        retryOf: input.retryOf ?? null,
        createdBy: input.createdBy,
        queuedAt: ctx.now(),
        startedAt: null,
        completedAt: null,
        cancelRequestedAt: null,
        attemptCount: 0,
        runner: 'in-memory',
        model: null,
        progress: null,
        usage: null,
        error: null,
        toolCalls: [],
        outputs: {
            messages: input.chatId && input.messageId ? [{ chatId: input.chatId, messageId: input.messageId }] : [],
            files: [],
            projectChanges: [],
        },
        report: { touchedProjects: [], externalSources: [] },
    };
    save(ctx, detail);
    recordActivity(ctx, {
        kind: 'run.queued',
        agentId: detail.agentId,
        actor: input.actor,
        runId: detail.id,
        source: detail.source,
    });
    return detail;
}

export type RunOutcome =
    | { readonly status: 'completed'; readonly usage?: RunUsage }
    | { readonly status: 'failed'; readonly error: RunError }
    | { readonly status: 'cancelled' };

/**
 * One step of a run's life: a queued run starts; a running one ends with `outcome`, or as `cancelled` once a cancel
 * was requested. A finished run does not move.
 */
export function advanceRun(ctx: EngineContext, runId: string, outcome: RunOutcome = { status: 'completed' }): Run {
    const detail = ctx.state.runs.get(runId);
    if (!detail) throw new Error(`No run ${runId}`);
    const actor: ActivityActor = { kind: 'system' };
    const ref = { agentId: detail.agentId, actor, runId: detail.id, source: detail.source };
    if (TERMINAL_RUN_STATUSES.includes(detail.status)) return runSummary(detail);
    const now = ctx.now();
    if (detail.status === 'queued' && detail.cancelRequestedAt === null && outcome.status !== 'cancelled') {
        const started = save(ctx, {
            ...detail,
            status: 'running',
            startedAt: now,
            attemptCount: detail.attemptCount + 1,
        });
        recordActivity(ctx, { kind: 'run.started', ...ref });
        return started;
    }
    const end = detail.cancelRequestedAt === null ? outcome : ({ status: 'cancelled' } as const);
    switch (end.status) {
        case 'completed': {
            const usage = end.usage ?? {
                inputTokens: null,
                outputTokens: null,
                durationMs: detail.startedAt === null ? null : time(now) - time(detail.startedAt),
                cost: null,
            };
            const run = save(ctx, { ...detail, status: 'completed', completedAt: now, usage });
            recordActivity(ctx, { kind: 'run.completed', ...ref, usage });
            return run;
        }
        case 'failed': {
            const run = save(ctx, { ...detail, status: 'failed', completedAt: now, error: end.error });
            recordActivity(ctx, { kind: 'run.failed', ...ref, error: end.error });
            return run;
        }
        case 'cancelled': {
            const run = save(ctx, { ...detail, status: 'cancelled', completedAt: now });
            recordActivity(ctx, { kind: 'run.cancelled', ...ref });
            return run;
        }
    }
}

/** The run producing a chat reply, if the engine runs them. */
export function runForMessage(ctx: EngineContext, messageId: string): RunDetail | undefined {
    return [...ctx.state.runs.values()].find((run) => run.messageId === messageId);
}

function found(ctx: EngineContext, runId: string): HandlerResult<RunDetail> {
    const detail = ctx.state.runs.get(runId);
    return detail ? ok(detail) : notFound('run');
}

export const RUN_HANDLERS: Pick<Handlers, 'listRuns' | 'getRunStats' | 'getRun' | 'cancelRun' | 'retryRun'> = {
    listRuns: ({ query }, ctx) => {
        const statuses = query.status === undefined ? undefined : new Set(query.status);
        const runs = [...ctx.state.runs.values()]
            .filter(
                (run) =>
                    (query.agentId === undefined || run.agentId === query.agentId) &&
                    (statuses === undefined || statuses.has(run.status)) &&
                    (query.source === undefined || run.source === query.source) &&
                    (query.triggerId === undefined || run.triggerId === query.triggerId) &&
                    (query.createdBy === undefined || run.createdBy === query.createdBy) &&
                    within(run.queuedAt, query.from, query.to),
            )
            .map(runSummary);
        return page(runs, sortParam<Run>(query.sort, { queuedAt: (run) => time(run.queuedAt) }), query);
    },
    getRunStats: ({ query }, ctx) => {
        const runs = [...ctx.state.runs.values()].filter(
            (run) => query.agentId === undefined || run.agentId === query.agentId,
        );
        const since = time(ctx.now()) - DAY_MS;
        const queued = runs.filter((run) => run.status === 'queued');
        const oldest = queued.map((run) => run.queuedAt).sort((a, b) => time(a) - time(b))[0];
        return ok({
            running: runs.filter((run) => run.status === 'running').length,
            queued: queued.length,
            failedLast24h: runs.filter(
                (run) => run.status === 'failed' && run.completedAt !== null && time(run.completedAt) >= since,
            ).length,
            oldestQueuedAt: oldest ?? null,
        });
    },
    getRun: ({ params }, ctx) => found(ctx, params.runId),
    cancelRun: ({ params }, ctx) => {
        const result = found(ctx, params.runId);
        if (result.kind === 'problem') return result;
        const detail = result.data;
        if (TERMINAL_RUN_STATUSES.includes(detail.status)) return fail('run-finished');
        if (detail.cancelRequestedAt !== null) return ok(runSummary(detail));
        return ok(save(ctx, { ...detail, cancelRequestedAt: ctx.now() }));
    },
    retryRun: ({ params }, ctx) => {
        const result = found(ctx, params.runId);
        if (result.kind === 'problem') return result;
        const failed = result.data;
        if (failed.status !== 'failed') return fail('run-not-retryable');
        const retry = queueRun(ctx, {
            agentId: failed.agentId,
            source: failed.source,
            ...(failed.chatId === null ? {} : { chatId: failed.chatId }),
            ...(failed.triggerId === null ? {} : { triggerId: failed.triggerId }),
            retryOf: failed.id,
            createdBy: ctx.member.id,
            actor: { kind: 'member', memberId: ctx.member.id },
        });
        return ok(runSummary(retry));
    },
};
