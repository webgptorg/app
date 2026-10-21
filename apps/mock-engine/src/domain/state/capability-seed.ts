import { ScheduleConfig } from '@ptbk/engine-api';
import { nextScheduleFireAt, runPreview, truncateRunText } from '@ptbk/engine-api/in-memory';
import type { InMemorySeed } from '@ptbk/engine-api/in-memory';

import type { TaskTemplate } from './capability-texts';
import {
    EMAIL_SUBJECTS,
    ATTACHMENTS,
    EXTERNAL_SOURCES,
    KNOWLEDGE_FILES,
    MODELS,
    OUTPUTS,
    PROJECT_FILES,
    PROJECTS,
    RUN_ERRORS,
    RUNNERS,
    TASKS,
    TOOLS,
} from './capability-texts';
import { generatePng } from './png';
import { hex, largeFixtureDiff, unifiedDiff, usageFor } from './run-content';
import type { ScenarioSize } from './scenarios';
import type { SeededSequence } from './seed-random';
import { createSeededSequence, hashSeed } from './seed-random';

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type Item<Key extends keyof InMemorySeed> =
    NonNullable<InMemorySeed[Key]> extends readonly (infer Record)[] ? Mutable<Record> : never;
type SeedRun = Item<'runs'>;
type SeedTrigger = Item<'triggers'>;
type SeedFire = Mutable<NonNullable<SeedTrigger['fires']>[number]>;
type SeedIntegration = Item<'integrations'>;
type SeedActivity = Item<'activity'>;
type SeedFile = Item<'files'>;
type ToolCall = SeedRun['toolCalls'][number];
type RunSource = SeedRun['source'];

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Seeded runs end before this much time ahead of the epoch, so every one of their timestamps lies before it. */
const QUIET_BEFORE_EPOCH = 30 * MINUTE;
const PNG_POOL = 48;
/** Lines in the fixture diff that exceeds `MAX_RUN_TEXT_BYTES`. */
const LARGE_DIFF_LINES = 4_000;

function iso(ms: number): string {
    return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

export interface SeedMemberRef {
    readonly id: string;
    readonly role: string;
    readonly displayName: string;
    readonly createdAt: string;
}

export interface SeedAgentRef {
    readonly id: string;
    readonly createdBy: string;
    readonly createdAt: string;
}

export interface SeedChatRef {
    readonly id: string;
    readonly agentId: string;
    readonly createdBy: string | null;
}

export interface SeedMessageRef {
    readonly id: string;
    readonly chatId: string;
    readonly role: string;
    readonly createdAt: string;
    /** Only user messages need it: they become the preview of the run that answered them. */
    readonly content: string;
}

export interface SeedSecretRef {
    readonly id: string;
    readonly name: string;
    readonly scope: { readonly kind: 'engine' } | { readonly kind: 'agent'; readonly agentId: string };
    readonly status: string;
}

export interface CapabilitySeedInput {
    readonly seed: number;
    readonly scenario: string;
    readonly size: ScenarioSize;
    readonly epochMs: number;
    /** The engine's hostname, for email trigger addresses. */
    readonly hostname: string;
    readonly members: readonly SeedMemberRef[];
    /** Live agents only. */
    readonly agents: readonly SeedAgentRef[];
    readonly chats: readonly SeedChatRef[];
    readonly messages: readonly SeedMessageRef[];
    readonly secrets: readonly SeedSecretRef[];
}

export type CapabilitySeed = Required<Pick<InMemorySeed, 'runs' | 'files' | 'triggers' | 'integrations' | 'activity'>>;

interface Context {
    readonly input: CapabilitySeedInput;
    readonly sequence: SeededSequence;
    readonly runs: SeedRun[];
    readonly activity: SeedActivity[];
    readonly writers: readonly SeedMemberRef[];
    readonly agentsById: ReadonlyMap<string, SeedAgentRef>;
}

/** Runs, files, triggers, integrations and activity for every C-07 capability, consistent with each other. */
export async function seedCapabilities(input: CapabilitySeedInput): Promise<CapabilitySeed> {
    const ctx: Context = {
        input,
        sequence: createSeededSequence(hashSeed(input.seed, input.scenario, 'capabilities')),
        runs: [],
        activity: [],
        writers: input.members.filter((member) => member.role !== 'viewer'),
        agentsById: new Map(input.agents.map((agent) => [agent.id, agent])),
    };
    if (input.agents.length === 0) return { runs: [], files: [], triggers: [], integrations: [], activity: [] };
    const integrations = seedIntegrations(ctx);
    const triggers = seedTriggers(ctx);
    seedWebRuns(ctx);
    seedOtherRuns(ctx);
    const files = await seedFiles(ctx);
    seedIntegrationUse(ctx, integrations);
    seedEngineActivity(ctx);
    for (const run of ctx.runs) runActivity(ctx, run);
    // Seeded timestamps share one format (to the second, `Z`), so text order is time order, and much cheaper.
    ctx.activity.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { runs: ctx.runs, files, triggers, integrations, activity: ctx.activity };
}

type DistributiveOmit<T, Key extends PropertyKey> = T extends unknown ? Omit<T, Key> : never;

function activity(ctx: Context, item: DistributiveOmit<SeedActivity, 'id' | 'v'>): void {
    ctx.activity.push({ ...item, v: 1, id: ctx.sequence.id('activity') });
}

interface RunPlan {
    readonly agentId: string;
    readonly source: RunSource;
    readonly queuedAtMs: number;
    readonly status: SeedRun['status'];
    readonly createdBy: string | null;
    readonly chatId?: string;
    readonly messageId?: string;
    readonly triggerId?: string;
    readonly retryOf?: string;
    /** Chat runs only produce the reply, and are fast. */
    readonly chat?: boolean;
    /** What started it; by default the task's title, as an API caller or member would have asked. */
    readonly preview?: string | null;
}

function toolCall(
    sequence: SeededSequence,
    startedAtMs: number,
    state: ToolCall['state'],
    tool = sequence.pick(TOOLS),
): ToolCall {
    const finished = state === 'complete' || state === 'error';
    const durationMs = finished ? sequence.int(80, 40_000) : null;
    const logs = state === 'pending' ? '' : state === 'error' ? tool.failed : tool.ok;
    return {
        id: sequence.id('tool'),
        name: tool.name,
        state,
        startedAt: state === 'pending' ? null : iso(startedAtMs),
        durationMs,
        logs: state === 'partial' ? (logs.split('\n')[0] ?? '') : logs,
        logsTruncated: false,
    };
}

/** Builds one run with steps, tool calls and usage that fit its status; it ends before the epoch. */
function buildRun(ctx: Context, plan: RunPlan): SeedRun {
    const { sequence } = ctx;
    const task: TaskTemplate = sequence.pick(TASKS);
    const model = sequence.pick(MODELS);
    const startedAtMs = plan.queuedAtMs + (plan.chat ? 0 : sequence.int(SECOND, 20 * SECOND));
    // A running run started minutes before the epoch, so what it did so far fits before it.
    const durationMs = plan.chat
        ? sequence.int(2 * SECOND, 50 * SECOND)
        : plan.status === 'running'
          ? sequence.int(10 * SECOND, 2 * MINUTE)
          : sequence.int(20 * SECOND, 25 * MINUTE);
    const completedAtMs = startedAtMs + durationMs;
    const terminal = plan.status !== 'queued' && plan.status !== 'running';
    const started = plan.status !== 'queued';
    const doneSteps =
        plan.status === 'completed'
            ? task.steps.length
            : plan.status === 'queued'
              ? 0
              : sequence.int(0, task.steps.length - 1);
    const toolCalls: ToolCall[] = [];
    if (started && !plan.chat) {
        const count = sequence.int(1, 3);
        for (let index = 0; index < count; index++) {
            const at = startedAtMs + Math.floor(((index + 1) * durationMs) / (count + 2));
            const last = index === count - 1;
            const state: ToolCall['state'] =
                plan.status === 'running'
                    ? last
                        ? sequence.pick(['pending', 'partial'] as const)
                        : 'complete'
                    : last && plan.status !== 'completed'
                      ? 'error'
                      : 'complete';
            toolCalls.push(toolCall(sequence, at, state));
        }
    }
    const error = plan.status === 'failed' ? sequence.pick(RUN_ERRORS) : null;
    const usage =
        plan.status === 'completed' || plan.status === 'failed'
            ? usageFor(sequence, model, durationMs)
            : plan.status === 'cancelled' && sequence.chance(0.5)
              ? { ...usageFor(sequence, model, durationMs), cost: null }
              : null;
    return {
        id: sequence.id('run'),
        agentId: plan.agentId,
        source: plan.source,
        status: plan.status,
        chatId: plan.chatId ?? null,
        messageId: plan.messageId ?? null,
        triggerId: plan.triggerId ?? null,
        retryOf: plan.retryOf ?? null,
        createdBy: plan.createdBy,
        queuedAt: iso(plan.queuedAtMs),
        startedAt: started ? iso(startedAtMs) : null,
        completedAt: terminal ? iso(completedAtMs) : null,
        cancelRequestedAt: plan.status === 'cancelled' ? iso(completedAtMs - sequence.int(SECOND, 5 * SECOND)) : null,
        attemptCount: started ? 1 : 0,
        runner: plan.chat ? 'promptbook' : sequence.pick(RUNNERS),
        model,
        progress: plan.chat
            ? null
            : {
                  title: task.title,
                  now: plan.status === 'running' ? (task.steps[doneSteps] ?? null) : null,
                  next: plan.status === 'running' ? (task.steps[doneSteps + 1] ?? null) : null,
                  items: task.steps.map((text, index) => ({
                      id: `step-${String(index + 1)}`,
                      text,
                      status: index < doneSteps ? ('completed' as const) : ('pending' as const),
                  })),
              },
        usage,
        error,
        preview: plan.preview === undefined ? task.title : plan.preview === null ? null : runPreview(plan.preview),
        toolCalls,
        outputs: {
            messages: plan.chatId && plan.messageId ? [{ chatId: plan.chatId, messageId: plan.messageId }] : [],
            files: [],
            fileNames: [],
            projectChanges: [],
        },
        report: {
            touchedProjects: [],
            externalSources: started && !plan.chat && sequence.chance(0.4) ? [sequence.pick(EXTERNAL_SOURCES)] : [],
        },
    };
}

function runActivity(ctx: Context, run: SeedRun): void {
    const ref = { agentId: run.agentId, runId: run.id, source: run.source };
    const actor = run.triggerId
        ? ({ kind: 'trigger', triggerId: run.triggerId } as const)
        : run.createdBy
          ? ({ kind: 'member', memberId: run.createdBy } as const)
          : ({ kind: 'system' } as const);
    // Only what is still pending is listed as queued: every other run's queueing shows in its start.
    if (run.status === 'queued') activity(ctx, { kind: 'run.queued', at: run.queuedAt, actor, ...ref });
    if (run.startedAt !== null)
        activity(ctx, { kind: 'run.started', at: run.startedAt, actor: { kind: 'system' }, ...ref });
    if (run.completedAt === null) return;
    const end = { at: run.completedAt, actor: { kind: 'system' } as const, ...ref };
    if (run.status === 'completed') activity(ctx, { kind: 'run.completed', ...end, usage: run.usage });
    if (run.status === 'failed') activity(ctx, { kind: 'run.failed', ...end, error: run.error });
    if (run.status === 'cancelled') activity(ctx, { kind: 'run.cancelled', ...end });
}

function terminalStatus(sequence: SeededSequence): SeedRun['status'] {
    const draw = sequence.next();
    return draw < 0.78 ? 'completed' : draw < 0.92 ? 'failed' : 'cancelled';
}

/** Every chat turn inside the run window got a `web` run that produced the agent's reply. */
function seedWebRuns(ctx: Context): void {
    const { input } = ctx;
    const since = input.epochMs - input.size.runDays * DAY;
    const chats = new Map(input.chats.map((chat) => [chat.id, chat]));
    // Messages come oldest first, so the user message a reply answers is the last one seen in its chat.
    const lastAsked = new Map<string, string>();
    for (const message of input.messages) {
        if (message.role === 'user') lastAsked.set(message.chatId, message.content);
        const at = Date.parse(message.createdAt);
        const chat = chats.get(message.chatId);
        if (message.role !== 'agent' || at < since || chat === undefined || !ctx.agentsById.has(chat.agentId)) continue;
        ctx.runs.push(
            buildRun(ctx, {
                agentId: chat.agentId,
                source: 'web',
                queuedAtMs: at,
                status: 'completed',
                createdBy: chat.createdBy,
                chatId: chat.id,
                messageId: message.id,
                chat: true,
                preview: lastAsked.get(message.chatId) ?? null,
            }),
        );
    }
}

const OTHER_SOURCES: readonly RunSource[] = ['api', 'api', 'member', 'member', 'goal', 'webhook'];
/** The first runs end each way, so even a small seed has every terminal status. */
const EVERY_END: readonly SeedRun['status'][] = ['completed', 'failed', 'cancelled'];

/** Runs from API clients, members, goals and webhooks, with retries of failures and a few still going. */
function seedOtherRuns(ctx: Context): void {
    const { input, sequence } = ctx;
    const end = input.epochMs - QUIET_BEFORE_EPOCH;
    const start = input.epochMs - input.size.runDays * DAY;
    const times = Array.from({ length: input.size.otherRuns }, () => sequence.int(start, end - 30 * MINUTE)).sort(
        (a, b) => a - b,
    );
    const agents = input.agents;
    for (const [index, at] of times.entries()) {
        // Every source appears even in a small seed.
        const source = index < OTHER_SOURCES.length ? (OTHER_SOURCES[index] ?? 'api') : sequence.pick(OTHER_SOURCES);
        const agent = sequence.pick(agents);
        const createdBy = source === 'api' || source === 'member' ? sequence.pick(ctx.writers).id : null;
        // The newest runs are still going: two running, then two queued.
        const fromEnd = times.length - index;
        const status: SeedRun['status'] =
            fromEnd <= 2 ? 'queued' : fromEnd <= 4 ? 'running' : (EVERY_END[index] ?? terminalStatus(sequence));
        const queuedAtMs = fromEnd <= 4 ? input.epochMs - fromEnd * 3 * MINUTE : at;
        let run = buildRun(ctx, { agentId: agent.id, source, queuedAtMs, status, createdBy });
        ctx.runs.push(run);
        // Some failures were retried, and a failed retry sometimes again.
        while (run.status === 'failed' && run.completedAt !== null && sequence.chance(0.45)) {
            const retryAt = Date.parse(run.completedAt) + sequence.int(MINUTE, 20 * MINUTE);
            if (retryAt > end - 30 * MINUTE) break;
            run = buildRun(ctx, {
                agentId: run.agentId,
                source: run.source,
                queuedAtMs: retryAt,
                status: sequence.chance(0.7) ? 'completed' : 'failed',
                createdBy: sequence.pick(ctx.writers).id,
                retryOf: run.id,
                preview: run.preview ?? null,
            });
            ctx.runs.push(run);
        }
    }
    addProjectChanges(ctx);
}

/** Coding runs commit to a project; one commits a generated fixture far over the run text limit. */
function addProjectChanges(ctx: Context): void {
    const { sequence } = ctx;
    const coding = ctx.runs.filter(
        (run) => run.status === 'completed' && run.source !== 'web' && sequence.chance(0.15),
    );
    for (const [index, run] of coding.entries()) {
        const project = sequence.pick(PROJECTS);
        const files = [...new Set([sequence.pick(PROJECT_FILES), sequence.pick(PROJECT_FILES)])];
        const change = index === 0 ? largeFixtureDiff(sequence, LARGE_DIFF_LINES) : unifiedDiff(files);
        const diff = truncateRunText(change.diff);
        run.outputs = {
            ...run.outputs,
            projectChanges: [
                {
                    projectName: project,
                    commitHash: hex(sequence, 40),
                    changedFiles: [...change.changedFiles],
                    diff: diff.text,
                    diffTruncated: diff.truncated,
                },
            ],
        };
        run.report = { ...run.report, touchedProjects: [project] };
    }
}

interface TriggerTemplate {
    readonly kind: 'email' | 'once' | 'interval' | 'cron';
    readonly lifecycle: 'active' | 'paused' | 'ended' | 'failed';
    readonly endedReason?: 'completed' | 'cancelled' | 'max-runs';
    readonly name: string;
}

/** Cycled through, so a seed of any size has schedules of every kind in every lifecycle. */
const TRIGGER_TEMPLATES: readonly TriggerTemplate[] = [
    { kind: 'email', lifecycle: 'active', name: 'Support inbox' },
    { kind: 'cron', lifecycle: 'active', name: 'Morning briefing' },
    { kind: 'interval', lifecycle: 'active', name: 'Check the status page' },
    { kind: 'once', lifecycle: 'ended', endedReason: 'completed', name: 'Launch-day announcement' },
    { kind: 'cron', lifecycle: 'paused', name: 'Friday release notes' },
    { kind: 'interval', lifecycle: 'ended', endedReason: 'max-runs', name: 'Daily invoice reminders' },
    { kind: 'cron', lifecycle: 'ended', endedReason: 'cancelled', name: 'Weekly churn report' },
    { kind: 'email', lifecycle: 'paused', name: 'Invoices inbox' },
    { kind: 'cron', lifecycle: 'failed', name: 'Nightly backlog grooming' },
    { kind: 'interval', lifecycle: 'ended', endedReason: 'completed', name: 'Conference week digest' },
    { kind: 'cron', lifecycle: 'active', name: 'Month-end close' },
    { kind: 'interval', lifecycle: 'paused', name: 'Competitor price watch' },
    { kind: 'email', lifecycle: 'active', name: 'Sales leads' },
    { kind: 'cron', lifecycle: 'active', name: 'Standup summary' },
];

const CRONS = [
    { expression: '0 8 * * 1-5', timeZone: 'Europe/Prague' },
    { expression: '30 9 * * *', timeZone: 'America/New_York' },
    { expression: '0 18 * * 5', timeZone: 'Asia/Tokyo' },
    { expression: '15 7 * * *', timeZone: 'UTC' },
] as const;

const MESSAGES = [
    'Summarise what happened since the last run and post it to #team.',
    'Check for new invoices and remind customers who are late.',
    'Look at the status page and report anything degraded.',
    'Prepare the release notes from the merged pull requests.',
] as const;

type Recurrence =
    | { readonly kind: 'once'; readonly at: string }
    | { readonly kind: 'interval'; readonly everySeconds: number }
    | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string };

/** Fire times from `startsAt`, as the core's own schedule computes them, up to `untilMs`. */
function fireTimes(
    recurrence: Recurrence,
    startsAt: string,
    endsAt: string | null,
    untilMs: number,
    max: number,
): number[] {
    const times: number[] = [];
    let last: string | null = null;
    for (let runCount = 0; runCount < max; runCount++) {
        const next = nextScheduleFireAt(
            ScheduleConfig.parse({ recurrence, startsAt, endsAt, maxRunCount: null, runCount, message: 'x' }),
            last ?? startsAt,
            last,
        );
        if (next === null || Date.parse(next) > untilMs) break;
        times.push(Date.parse(next));
        last = next;
    }
    return times;
}

function seedTriggers(ctx: Context): SeedTrigger[] {
    const { input, sequence } = ctx;
    const latestFire = input.epochMs - QUIET_BEFORE_EPOCH - 30 * MINUTE;
    const windowStart = input.epochMs - (input.size.runDays - 1) * DAY;
    const triggers: SeedTrigger[] = [];
    for (let index = 0; index < input.size.triggers; index++) {
        const template = TRIGGER_TEMPLATES[index % TRIGGER_TEMPLATES.length] ?? TRIGGER_TEMPLATES[0];
        if (template === undefined) break;
        const round = Math.floor(index / TRIGGER_TEMPLATES.length);
        const agent = sequence.pick(input.agents);
        const id = sequence.id('trigger');
        const createdBy = sequence.pick(ctx.writers).id;
        const wanted = sequence.int(...input.size.firesPerTrigger);
        const name = round === 0 ? template.name : `${template.name} ${String(round + 1)}`;
        let fireAt: number[];
        let config: SeedTrigger['trigger']['config'];
        let recurrence: Recurrence | null = null;
        let startsAtMs: number;
        let preview: (fireIndex: number) => string | null;
        if (template.kind === 'email') {
            startsAtMs = input.epochMs - sequence.int(5 * DAY, 13 * DAY);
            fireAt = Array.from({ length: wanted }, () => sequence.int(startsAtMs + HOUR, latestFire)).sort(
                (a, b) => a - b,
            );
            config = { address: `${id}@${input.hostname}` };
            preview = (fireIndex) => EMAIL_SUBJECTS[(index + fireIndex) % EMAIL_SUBJECTS.length] ?? null;
        } else {
            const span = template.lifecycle === 'active' ? latestFire : input.epochMs - sequence.int(DAY, 4 * DAY);
            if (template.kind === 'once') {
                startsAtMs = span - sequence.int(DAY, 3 * DAY);
                recurrence = { kind: 'once', at: iso(span) };
            } else if (template.kind === 'interval') {
                const everySeconds = sequence.pick([6 * 3600, 8 * 3600, 12 * 3600]);
                startsAtMs = Math.max(windowStart, span - wanted * everySeconds * SECOND);
                recurrence = { kind: 'interval', everySeconds };
            } else {
                const cron = CRONS[index % CRONS.length] ?? CRONS[0];
                startsAtMs = windowStart;
                recurrence = { kind: 'cron', expression: cron.expression, timeZone: cron.timeZone };
            }
            startsAtMs = Math.floor(startsAtMs / MINUTE) * MINUTE;
            const endsAt =
                template.endedReason === 'completed' && template.kind === 'interval' ? iso(span + MINUTE) : null;
            // The newest fires are the history; the schedule starts with the first of them, so none is missing.
            fireAt = fireTimes(recurrence, iso(startsAtMs), endsAt, Math.min(span, latestFire), 1_000).slice(-wanted);
            const first = fireAt[0];
            if (template.kind === 'interval' && first !== undefined) startsAtMs = first;
            if (template.kind === 'cron' && first !== undefined) startsAtMs = first - sequence.int(1, 59) * MINUTE;
            config = {
                recurrence,
                startsAt: iso(startsAtMs),
                endsAt,
                maxRunCount: null,
                runCount: 0,
                message: sequence.pick(MESSAGES),
            };
            const message = config.message;
            preview = () => message;
        }
        const fires: SeedFire[] = [];
        const skipFrom = template.lifecycle === 'paused' && fireAt.length > 1 ? fireAt.length - 1 : fireAt.length;
        for (const [fireIndex, at] of fireAt.entries()) {
            const lastFire = fireIndex === fireAt.length - 1;
            if (fireIndex >= skipFrom) {
                // Fired while paused: recorded and skipped.
                fires.push({ id: sequence.id('fire'), at: iso(at), outcome: 'skipped', runId: null, error: null });
                continue;
            }
            if (template.lifecycle === 'failed' && lastFire) {
                const error = {
                    code: 'invalid-credentials',
                    summary: 'The calendar token expired, so the schedule stopped.',
                };
                fires.push({ id: sequence.id('fire'), at: iso(at), outcome: 'failed', runId: null, error });
                activity(ctx, {
                    kind: 'trigger.failed',
                    at: iso(at),
                    agentId: agent.id,
                    actor: { kind: 'trigger', triggerId: id },
                    triggerId: id,
                    name,
                    error,
                });
                continue;
            }
            const run = buildRun(ctx, {
                agentId: agent.id,
                source: template.kind === 'email' ? 'email' : 'schedule',
                queuedAtMs: at,
                status: terminalStatus(sequence),
                createdBy: null,
                triggerId: id,
                preview: preview(fireIndex),
            });
            ctx.runs.push(run);
            fires.push({ id: sequence.id('fire'), at: iso(at), outcome: 'started', runId: run.id, error: null });
            activity(ctx, {
                kind: 'trigger.fired',
                at: iso(at),
                agentId: agent.id,
                actor: { kind: 'trigger', triggerId: id },
                triggerId: id,
                name,
                runId: run.id,
            });
        }
        const lastFiredAt = fireAt.length === 0 ? null : iso(fireAt.at(-1) ?? 0);
        const createdAtMs = Math.min(startsAtMs, (fireAt[0] ?? input.epochMs) - HOUR);
        const pausedAtMs = (fireAt.at(skipFrom - 1) ?? createdAtMs) + 5 * MINUTE;
        const updatedAtMs =
            template.lifecycle === 'active'
                ? Date.parse(lastFiredAt ?? iso(createdAtMs))
                : Math.max(pausedAtMs, (fireAt.at(-1) ?? createdAtMs) + MINUTE);
        if ('recurrence' in config) {
            const runCount = fires.filter(({ outcome }) => outcome === 'started').length;
            config = {
                ...config,
                runCount,
                maxRunCount: template.endedReason === 'max-runs' ? Math.max(1, runCount) : null,
            };
        }
        let nextFireAt: string | null = null;
        if (template.lifecycle === 'active' && recurrence !== null && 'recurrence' in config) {
            const next = nextScheduleFireAt(ScheduleConfig.parse(config), iso(input.epochMs), lastFiredAt);
            nextFireAt = next === null ? null : iso(Date.parse(next));
        }
        if (template.lifecycle === 'paused') {
            const pausedAt = iso(pausedAtMs);
            const ref = {
                agentId: agent.id,
                actor: { kind: 'member', memberId: createdBy } as const,
                triggerId: id,
                name,
            };
            activity(ctx, { kind: 'trigger.paused', at: pausedAt, ...ref });
        }
        triggers.push({
            trigger: {
                id,
                agentId: agent.id,
                name,
                kind: template.kind === 'email' ? 'email' : 'schedule',
                lifecycle: template.lifecycle,
                endedReason: template.endedReason ?? null,
                lastFiredAt,
                nextFireAt,
                createdBy,
                createdAt: iso(createdAtMs),
                updatedAt: iso(updatedAtMs),
                config,
            } as SeedTrigger['trigger'],
            fires,
        });
    }
    return triggers;
}

interface IntegrationTemplate {
    readonly kind: 'mcp-server' | 'calendar' | 'repository';
    readonly name: string;
    readonly scope: 'engine' | 'agent';
    readonly secrets: 'resolved' | 'missing' | 'revoked' | 'none';
    readonly status: SeedIntegration['status'];
    readonly statusDetail?: string;
    readonly target: string;
    readonly scopes: readonly string[];
    readonly tools: readonly { readonly name: string; readonly description: string | null }[];
}

const INTEGRATION_TEMPLATES: readonly IntegrationTemplate[] = [
    {
        kind: 'mcp-server',
        name: 'Docs search',
        scope: 'engine',
        secrets: 'resolved',
        status: 'connected',
        target: 'https://mcp.docs.example.com/sse',
        scopes: [],
        tools: [
            { name: 'docs.search', description: 'Full-text search over the help centre' },
            { name: 'docs.get_page', description: 'Read one page as Markdown' },
        ],
    },
    {
        kind: 'repository',
        name: 'Website repository',
        scope: 'agent',
        secrets: 'revoked',
        status: 'needs-attention',
        target: 'acme/website',
        scopes: ['contents:write', 'pull_requests:write'],
        tools: [
            { name: 'github.search_code', description: 'Search the repository' },
            { name: 'github.create_pull_request', description: 'Open a pull request from a branch' },
        ],
    },
    {
        kind: 'calendar',
        name: 'Team calendar',
        scope: 'agent',
        secrets: 'none',
        status: 'connected',
        target: 'google:team@acme.example',
        scopes: ['calendar.readonly'],
        tools: [{ name: 'calendar.list_events', description: 'List events in a time range' }],
    },
    {
        kind: 'mcp-server',
        name: 'Sentry',
        scope: 'agent',
        secrets: 'missing',
        status: 'needs-attention',
        target: 'https://mcp.sentry.example.com/sse',
        scopes: [],
        tools: [],
    },
    {
        kind: 'mcp-server',
        name: 'Slack',
        scope: 'engine',
        secrets: 'resolved',
        status: 'error',
        statusDetail: 'Connection refused by mcp.slack.example.com (ECONNREFUSED).',
        target: 'https://mcp.slack.example.com/sse',
        scopes: [],
        tools: [{ name: 'slack.post_message', description: 'Post a message to a channel' }],
    },
    {
        kind: 'repository',
        name: 'Billing service',
        scope: 'engine',
        secrets: 'none',
        status: 'connected',
        target: 'acme/billing-service',
        scopes: ['contents:read'],
        tools: [{ name: 'github.search_code', description: 'Search the repository' }],
    },
    {
        kind: 'mcp-server',
        name: 'Analytics warehouse',
        scope: 'agent',
        secrets: 'resolved',
        status: 'disconnected',
        target: 'https://mcp.warehouse.example.com/sse',
        scopes: [],
        tools: [{ name: 'sql.query', description: 'Run a read-only SQL query' }],
    },
    {
        kind: 'calendar',
        name: 'Office calendar',
        scope: 'engine',
        secrets: 'none',
        status: 'connected',
        target: 'microsoft:office@acme.example',
        scopes: ['Calendars.Read'],
        tools: [{ name: 'calendar.list_events', description: null }],
    },
];

/** Secret names nobody seeded, so a reference to one is `missing`. */
const MISSING_SECRET = 'SENTRY_AUTH_TOKEN';

function seedIntegrations(ctx: Context): SeedIntegration[] {
    const { input, sequence } = ctx;
    const engineSecrets = input.secrets.filter((secret) => secret.scope.kind === 'engine');
    const active = engineSecrets.filter((secret) => secret.status === 'active');
    const revoked = input.secrets.filter((secret) => secret.status === 'revoked' && secret.scope.kind === 'engine');
    const integrations: SeedIntegration[] = [];
    for (let index = 0; index < input.size.integrations; index++) {
        const template = INTEGRATION_TEMPLATES[index % INTEGRATION_TEMPLATES.length] ?? INTEGRATION_TEMPLATES[0];
        if (template === undefined) break;
        const round = Math.floor(index / INTEGRATION_TEMPLATES.length);
        const agentId = template.scope === 'agent' ? sequence.pick(input.agents).id : null;
        let secretRefs: SeedIntegration['secretRefs'] = [];
        const resolvedSecret = active.length > 0 ? sequence.pick(active) : undefined;
        const revokedSecret = revoked.length > 0 ? sequence.pick(revoked) : undefined;
        if (template.secrets === 'resolved' && resolvedSecret) {
            secretRefs = [{ name: resolvedSecret.name, secretId: resolvedSecret.id, state: 'resolved' }];
        } else if (template.secrets === 'revoked' && revokedSecret) {
            secretRefs = [{ name: revokedSecret.name, secretId: revokedSecret.id, state: 'revoked' }];
        } else if (template.secrets === 'missing' || template.secrets === 'revoked') {
            secretRefs = [{ name: MISSING_SECRET, secretId: null, state: 'missing' }];
        }
        const unresolved = secretRefs.filter(({ state }) => state !== 'resolved').map(({ name }) => name);
        const status: SeedIntegration['status'] =
            unresolved.length > 0
                ? 'needs-attention'
                : template.status === 'needs-attention'
                  ? 'connected'
                  : template.status;
        const statusDetail =
            unresolved.length > 0
                ? `Secrets not available: ${unresolved.join(', ')}.`
                : status === 'error'
                  ? (template.statusDetail ?? null)
                  : null;
        const createdAtMs = input.epochMs - sequence.int(15 * DAY, 60 * DAY);
        const base = {
            id: sequence.id('integration'),
            agentId,
            name: round === 0 ? template.name : `${template.name} ${String(round + 1)}`,
            status,
            statusDetail,
            scopes: [...template.scopes],
            secretRefs,
            tools: template.tools.map((tool) => ({ ...tool })),
            lastActivityAt: null,
            createdBy: sequence.pick(ctx.writers).id,
            createdAt: iso(createdAtMs),
            updatedAt: iso(createdAtMs + sequence.int(MINUTE, 10 * DAY)),
        };
        const [provider = 'google', account = 'team@acme.example'] = template.target.split(':');
        const integration: SeedIntegration =
            template.kind === 'mcp-server'
                ? { ...base, kind: 'mcp-server' as const, config: { url: template.target } }
                : template.kind === 'calendar'
                  ? { ...base, kind: 'calendar' as const, config: { provider, account } }
                  : {
                        ...base,
                        kind: 'repository' as const,
                        config: { provider: 'github' as const, repository: template.target },
                    };
        integrations.push(integration);
        const ref = {
            at: base.createdAt,
            agentId,
            actor: { kind: 'member', memberId: base.createdBy } as const,
            integrationId: base.id,
            name: base.name,
        };
        if (status === 'needs-attention' || status === 'error') {
            activity(ctx, {
                kind: 'integration.error',
                ...ref,
                at: base.updatedAt,
                actor: { kind: 'system' },
                statusDetail,
            });
        } else {
            activity(ctx, { kind: 'integration.connected', ...ref });
        }
    }
    return integrations;
}

/** Connected integrations were used by some of their agents' runs. */
function seedIntegrationUse(ctx: Context, integrations: SeedIntegration[]): void {
    const { sequence } = ctx;
    const byAgent = new Map<string, SeedRun[]>();
    const started = ctx.runs.filter((run) => run.startedAt !== null && run.source !== 'web');
    for (const run of started) byAgent.set(run.agentId, [...(byAgent.get(run.agentId) ?? []), run]);
    for (const integration of integrations) {
        if (integration.status !== 'connected' || integration.tools.length === 0) continue;
        const candidates = integration.agentId === null ? started : (byAgent.get(integration.agentId) ?? []);
        let latest: string | null = null;
        for (let use = 0; use < 4 && candidates.length > 0; use++) {
            const run = sequence.pick(candidates);
            const at = iso(Date.parse(run.startedAt ?? run.queuedAt) + sequence.int(SECOND, 30 * SECOND));
            activity(ctx, {
                kind: 'integration.used',
                at,
                agentId: run.agentId,
                actor: { kind: 'system' },
                integrationId: integration.id,
                name: integration.name,
                toolName: sequence.pick(integration.tools).name,
                runId: run.id,
            });
            if (latest === null || at > latest) latest = at;
        }
        integration.lastActivityAt = latest;
    }
}

function seedEngineActivity(ctx: Context): void {
    const { input, sequence } = ctx;
    const system = { kind: 'system' } as const;
    for (const member of input.members.slice(1)) {
        activity(ctx, {
            kind: 'member.joined',
            at: member.createdAt,
            agentId: null,
            actor: system,
            memberId: member.id,
            displayName: member.displayName,
        });
    }
    const relayAt = input.epochMs - sequence.int(DAY, 6 * DAY);
    activity(ctx, {
        kind: 'engine.relay-disconnected',
        at: iso(relayAt),
        agentId: null,
        actor: system,
        relay: 'relay-eu-2.ptbk.io',
    });
    activity(ctx, {
        kind: 'engine.update-available',
        at: iso(relayAt + HOUR),
        agentId: null,
        actor: system,
        version: '1.4.0',
    });
    activity(ctx, {
        kind: 'engine.updated',
        at: iso(relayAt + DAY),
        agentId: null,
        actor: system,
        fromVersion: '1.3.2',
        toVersion: '1.4.0',
    });
}

const TEXT_LINES = [
    'Escalate to a human when the customer mentions a refund over 500 EUR.',
    'Always answer in the customer’s language; keep replies under 120 words.',
    'Enterprise customers have a four-hour response target.',
    'Never share internal ticket links with customers.',
    'Prices are listed without VAT unless the customer is in the EU.',
] as const;

function textContent(sequence: SeededSequence, name: string): string {
    if (name.endsWith('.json')) {
        return `${JSON.stringify({ generatedBy: 'mock engine', items: [sequence.int(1, 99), sequence.int(1, 99)] }, null, 2)}\n`;
    }
    if (name.endsWith('.csv')) {
        return `sku,name,price\nA-${String(sequence.int(100, 999))},Starter plan,19\nB-${String(sequence.int(100, 999))},Team plan,49\n`;
    }
    const heading = name.replace(/\.[a-z]+$/, '').replace(/-/g, ' ');
    return `# ${heading.charAt(0).toUpperCase()}${heading.slice(1)}\n\n- ${sequence.pick(TEXT_LINES)}\n- ${sequence.pick(TEXT_LINES)}\n`;
}

interface PlannedFile {
    readonly metadata: Omit<SeedFile['metadata'], 'sha256' | 'sizeBytes'>;
    /** The bytes of each version, oldest first; the last one is the current content. */
    readonly versions: readonly {
        readonly bytes: () => Promise<Uint8Array<ArrayBuffer>>;
        readonly createdAt: string;
        readonly commitHash: string | null;
        readonly runId: string | null;
    }[];
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Knowledge files per agent (git-backed project files with several versions among them), chat attachments, run
 * outputs (some of them generated PNGs) and engine-wide uploads; one infected, a few pending or failed scans.
 */
async function seedFiles(ctx: Context): Promise<SeedFile[]> {
    const { input, sequence } = ctx;
    const planned: PlannedFile[] = [];
    const text = (content: string) => () => Promise.resolve(new TextEncoder().encode(content));
    // A pool of pictures per seed: enough variety to look real, and a large fleet does not draw thousands.
    const pictures = new Map<number, Promise<Uint8Array<ArrayBuffer>>>();
    const png = (fileSeed: number) => () => {
        let picture = pictures.get(fileSeed);
        if (picture === undefined) {
            picture = generatePng(createSeededSequence(fileSeed));
            pictures.set(fileSeed, picture);
        }
        return picture;
    };
    const bytesFor = (name: string) =>
        name.endsWith('.png')
            ? png(hashSeed(input.seed, input.scenario, 'png', planned.length % PNG_POOL))
            : text(textContent(sequence, name));
    const clean = (createdAtMs: number) => ({
        status: 'clean' as const,
        checkedAt: iso(createdAtMs + sequence.int(2 * SECOND, MINUTE)),
    });
    const add = (
        metadata: Omit<PlannedFile['metadata'], 'id' | 'scan'> & { readonly scan?: PlannedFile['metadata']['scan'] },
        versions?: PlannedFile['versions'],
    ) => {
        const createdAtMs = Date.parse(metadata.createdAt);
        planned.push({
            metadata: { id: sequence.id('file'), scan: clean(createdAtMs), ...metadata },
            versions: versions ?? [
                {
                    bytes: bytesFor(metadata.name),
                    createdAt: metadata.createdAt,
                    commitHash: null,
                    runId: metadata.runId ?? null,
                },
            ],
        });
    };

    const commits = new Map<string, SeedRun[]>();
    for (const run of ctx.runs) {
        if (run.outputs.projectChanges.length > 0) commits.set(run.agentId, [...(commits.get(run.agentId) ?? []), run]);
    }
    for (const agent of input.agents) {
        const count = sequence.int(...input.size.knowledgeFilesPerAgent);
        for (let index = 0; index < count; index++) {
            const kind =
                KNOWLEDGE_FILES[(index + sequence.int(0, KNOWLEDGE_FILES.length - 1)) % KNOWLEDGE_FILES.length] ??
                KNOWLEDGE_FILES[0];
            const createdAtMs = Math.max(Date.parse(agent.createdAt), input.epochMs - sequence.int(20 * DAY, 90 * DAY));
            add({
                name: kind.name,
                contentType: kind.contentType,
                purpose: 'knowledge',
                agentId: agent.id,
                chatId: null,
                runId: null,
                createdBy: agent.createdBy,
                createdAt: iso(createdAtMs),
            });
        }
        // An agent that commits to a project keeps its files in git: each commit is a version.
        const runs = (commits.get(agent.id) ?? []).sort(
            (a, b) => Date.parse(a.completedAt ?? a.queuedAt) - Date.parse(b.completedAt ?? b.queuedAt),
        );
        if (runs.length > 0) {
            const template = sequence.pick(PROJECT_FILES);
            const versions = runs.slice(0, 4).map((run, index) => {
                const change = run.outputs.projectChanges[0];
                const lines = index % 2 === 0 ? template.after : template.before;
                return {
                    bytes: text(`${lines.join('\n')}\n`),
                    createdAt: run.completedAt ?? run.queuedAt,
                    commitHash: change?.commitHash ?? null,
                    runId: run.id,
                };
            });
            const name = template.path.split('/').at(-1) ?? template.path;
            const first = versions[0];
            add(
                {
                    name,
                    contentType: name.endsWith('.json')
                        ? 'application/json'
                        : name.endsWith('.md')
                          ? 'text/markdown'
                          : 'text/plain',
                    purpose: 'knowledge',
                    agentId: agent.id,
                    chatId: null,
                    runId: null,
                    createdBy: agent.createdBy,
                    createdAt: first?.createdAt ?? agent.createdAt,
                },
                versions,
            );
        }
    }
    const messagesByChat = new Map<string, string>();
    for (const message of input.messages)
        if (message.role === 'user' && !messagesByChat.has(message.chatId))
            messagesByChat.set(message.chatId, message.createdAt);
    for (const chat of input.chats) {
        const at = messagesByChat.get(chat.id);
        if (
            chat.createdBy === null ||
            at === undefined ||
            !ctx.agentsById.has(chat.agentId) ||
            !sequence.chance(input.size.attachmentRate)
        )
            continue;
        const kind = sequence.pick(ATTACHMENTS);
        add({
            name: kind.name,
            contentType: kind.contentType,
            purpose: 'attachment',
            agentId: chat.agentId,
            chatId: chat.id,
            runId: null,
            createdBy: chat.createdBy,
            createdAt: at,
        });
    }
    for (const run of ctx.runs) {
        if (
            run.status !== 'completed' ||
            run.source === 'web' ||
            run.completedAt === null ||
            !sequence.chance(input.size.outputFileRate)
        )
            continue;
        const kind = sequence.pick(OUTPUTS);
        const agent = ctx.agentsById.get(run.agentId);
        add({
            name: kind.name,
            contentType: kind.contentType,
            purpose: 'output',
            agentId: run.agentId,
            chatId: run.chatId,
            runId: run.id,
            createdBy: run.createdBy ?? agent?.createdBy ?? ctx.writers[0]?.id ?? '',
            createdAt: run.completedAt,
        });
    }
    // Engine-wide uploads, and the scans that did not come back clean.
    const uploader = () =>
        sequence.pick(input.members.filter((member) => member.role === 'owner' || member.role === 'admin')).id;
    const recent = (fromEnd: number) => input.epochMs - fromEnd * 7 * MINUTE;
    add({
        name: 'company-handbook.md',
        contentType: 'text/markdown',
        purpose: 'upload',
        agentId: null,
        chatId: null,
        runId: null,
        createdBy: uploader(),
        createdAt: iso(input.epochMs - 30 * DAY),
    });
    add({
        name: 'invoice.pdf.exe',
        contentType: 'application/x-msdownload',
        purpose: 'attachment',
        agentId: input.agents[0]?.id ?? null,
        chatId: null,
        runId: null,
        createdBy: uploader(),
        createdAt: iso(recent(9)),
        scan: { status: 'infected', checkedAt: iso(recent(9) + 20 * SECOND) },
    });
    for (const [index, name] of ['q3-board-deck-notes.md', 'vendor-list.csv'].entries()) {
        add({
            name,
            contentType: name.endsWith('.csv') ? 'text/csv' : 'text/markdown',
            purpose: 'upload',
            agentId: null,
            chatId: null,
            runId: null,
            createdBy: uploader(),
            createdAt: iso(recent(index + 1)),
            scan: { status: 'pending', checkedAt: null },
        });
    }
    for (const [index, name] of ['archive-2023.json', 'scanned-receipts.csv'].entries()) {
        const at = recent(index + 4);
        add({
            name,
            contentType: name.endsWith('.csv') ? 'text/csv' : 'application/json',
            purpose: 'upload',
            agentId: null,
            chatId: null,
            runId: null,
            createdBy: uploader(),
            createdAt: iso(at),
            scan: { status: 'failed', checkedAt: iso(at + MINUTE) },
        });
    }

    const runsById = new Map(ctx.runs.map((run) => [run.id, run]));
    const files: SeedFile[] = [];
    // Contents are generated and hashed all at once; everything that draws from the sequence happens below, in order.
    const hashed = await Promise.all(
        planned.map((plan) =>
            Promise.all(
                plan.versions.map(async (version) => {
                    const bytes = await version.bytes();
                    return { ...version, bytes, sha256: await sha256Hex(bytes) };
                }),
            ),
        ),
    );
    for (const [index, plan] of planned.entries()) {
        const versions = hashed[index] ?? [];
        const current = versions.at(-1);
        if (current === undefined) continue;
        const { metadata } = plan;
        const blobs = versions.map(({ bytes }) => new Blob([bytes], { type: metadata.contentType }));
        files.push({
            metadata: { ...metadata, sha256: current.sha256, sizeBytes: current.bytes.byteLength },
            content: blobs.at(-1) ?? new Blob(),
            versions: versions.map((version, at) => ({
                version: {
                    id: sequence.id('version'),
                    createdAt: version.createdAt,
                    sizeBytes: version.bytes.byteLength,
                    sha256: version.sha256,
                    commitHash: version.commitHash,
                    runId: version.runId,
                },
                content: blobs[at] ?? new Blob(),
            })),
        });
        const producer = metadata.runId ? runsById.get(metadata.runId) : undefined;
        if (producer) {
            producer.outputs = {
                ...producer.outputs,
                files: [...producer.outputs.files, metadata.id],
                fileNames: [...(producer.outputs.fileNames ?? []), metadata.name],
            };
        }
        const actor =
            metadata.purpose === 'output'
                ? ({ kind: 'system' } as const)
                : ({ kind: 'member', memberId: metadata.createdBy } as const);
        activity(ctx, {
            kind: 'file.created',
            at: metadata.createdAt,
            agentId: metadata.agentId,
            actor,
            fileId: metadata.id,
            name: metadata.name,
            purpose: metadata.purpose,
        });
        if (metadata.scan.status === 'failed') {
            activity(ctx, {
                kind: 'file.scan-failed',
                at: metadata.scan.checkedAt ?? metadata.createdAt,
                agentId: metadata.agentId,
                actor: { kind: 'system' },
                fileId: metadata.id,
                name: metadata.name,
            });
        }
    }
    return files;
}
