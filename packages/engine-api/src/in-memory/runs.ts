import { z } from 'zod';

import type { ActivityActor } from '../capabilities/activity';
import { ProjectChange, Run, RunProgress, TERMINAL_RUN_STATUSES, ToolCall } from '../capabilities/runs';
import type { RunDetail, RunError, RunSource, RunStatus, RunUsage } from '../capabilities/runs';
import { stripUnknownFields } from '../tolerant';
import { ChatId, MemberId, RunId, TriggerId } from '../common';
import type { AgentId, FileId, MessageId } from '../common';
import { MAX_RUN_TEXT_BYTES } from '../constants';
import { fail, liveAgent, notFound, ok, page, recordActivity, sortParam, time, within } from './kit';
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

export function queueRun(ctx: EngineContext, input: NewRun & RunnerInfo): RunDetail {
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
        runner: input.runner ?? 'in-memory',
        model: input.model ?? null,
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

export interface RunnerInfo {
    readonly runner?: string | null;
    readonly model?: string | null;
}

/** A run the engine starts on its own or on an API client's behalf, outside a chat turn or a trigger. */
export interface StartRun extends RunnerInfo {
    readonly agentId: string;
    readonly source: RunSource;
    readonly chatId?: string;
    readonly triggerId?: string;
    readonly retryOf?: string;
    /** The member it runs for; `null` (the default) for a run no member started. */
    readonly createdBy?: string | null;
}

/** Queues a run as the system (or as `createdBy`); throws for an unknown or deleted agent or an unknown member. */
export function startRun(ctx: EngineContext, input: StartRun): Run {
    const agent = liveAgent(ctx, input.agentId);
    if (agent.kind === 'problem') throw new Error(`cannot start a run: ${agent.problem.code}`);
    const createdBy =
        input.createdBy === undefined || input.createdBy === null ? null : MemberId.parse(input.createdBy);
    if (createdBy !== null && !ctx.state.members.has(createdBy)) throw new Error('run for an unknown member');
    const detail = queueRun(ctx, {
        agentId: agent.data.id,
        source: input.source,
        ...(input.chatId === undefined ? {} : { chatId: ChatId.parse(input.chatId) }),
        ...(input.triggerId === undefined ? {} : { triggerId: TriggerId.parse(input.triggerId) }),
        ...(input.retryOf === undefined ? {} : { retryOf: RunId.parse(input.retryOf) }),
        createdBy,
        actor: createdBy === null ? { kind: 'system' } : { kind: 'member', memberId: createdBy },
        ...(input.runner === undefined ? {} : { runner: input.runner }),
        ...(input.model === undefined ? {} : { model: input.model }),
    });
    return runSummary(detail);
}

/** UTF-8 text cut to `MAX_RUN_TEXT_BYTES` on a code point boundary, as an engine stores logs and diffs. */
export function truncateRunText(text: string): { readonly text: string; readonly truncated: boolean } {
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= MAX_RUN_TEXT_BYTES) return { text, truncated: false };
    let end = MAX_RUN_TEXT_BYTES;
    // Back up over continuation bytes (10xxxxxx), so the cut never splits a character.
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/** What a runner reports while a run is going; a tool call replaces the one with its `id`, or is appended. */
export interface RunReport extends RunnerInfo {
    readonly progress?: unknown;
    readonly toolCall?: unknown;
}

/** Logs and diffs arrive whole; the engine cuts them to the contract's limit and sets the flag. */
const ToolCallReport = ToolCall.extend({ logs: z.string(), logsTruncated: z.boolean().default(false) });
const ProjectChangeReport = ProjectChange.extend({ diff: z.string(), diffTruncated: z.boolean().default(false) });

function activeRun(ctx: EngineContext, runId: string): RunDetail {
    const detail = ctx.state.runs.get(runId);
    if (!detail) throw new Error(`No run ${runId}`);
    return detail;
}

/** Progress of a queued or running run; throws once it finished, since a finished run does not change. */
export function reportRunProgress(ctx: EngineContext, runId: string, report: RunReport): Run {
    const detail = activeRun(ctx, runId);
    if (TERMINAL_RUN_STATUSES.includes(detail.status)) throw new Error(`Run ${runId} already finished`);
    let toolCalls = detail.toolCalls;
    if (report.toolCall !== undefined) {
        const input = ToolCallReport.parse(report.toolCall);
        const logs = truncateRunText(input.logs);
        const call = ToolCall.parse({
            ...input,
            logs: logs.text,
            logsTruncated: input.logsTruncated || logs.truncated,
        });
        const index = toolCalls.findIndex(({ id }) => id === call.id);
        toolCalls =
            index === -1 ? [...toolCalls, call] : toolCalls.map((existing, at) => (at === index ? call : existing));
    }
    return save(ctx, {
        ...detail,
        ...(report.progress === undefined ? {} : { progress: RunProgress.nullable().parse(report.progress) }),
        ...(report.runner === undefined ? {} : { runner: report.runner }),
        ...(report.model === undefined ? {} : { model: report.model }),
        toolCalls,
    });
}

/** A commit the run made; the diff is truncated to the contract's limit. Allowed after the run finished, too. */
export function addProjectChange(ctx: EngineContext, runId: string, change: unknown): Run {
    const detail = activeRun(ctx, runId);
    const input = ProjectChangeReport.parse(change);
    const diff = truncateRunText(input.diff);
    const parsed = ProjectChange.parse({
        ...input,
        diff: diff.text,
        diffTruncated: input.diffTruncated || diff.truncated,
    });
    const touched = detail.report.touchedProjects.includes(parsed.projectName)
        ? detail.report.touchedProjects
        : [...detail.report.touchedProjects, parsed.projectName];
    return save(ctx, {
        ...detail,
        outputs: { ...detail.outputs, projectChanges: [...detail.outputs.projectChanges, parsed] },
        report: { ...detail.report, touchedProjects: touched },
    });
}

/** A file the run produced, listed in its outputs. */
export function addRunOutputFile(ctx: EngineContext, runId: string, fileId: FileId): void {
    const detail = activeRun(ctx, runId);
    save(ctx, { ...detail, outputs: { ...detail.outputs, files: [...detail.outputs.files, fileId] } });
}

export function findRuns(ctx: EngineContext, filter: { readonly status?: readonly RunStatus[] }): RunDetail[] {
    const statuses = filter.status === undefined ? undefined : new Set(filter.status);
    return [...ctx.state.runs.values()].filter((run) => statuses === undefined || statuses.has(run.status));
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
