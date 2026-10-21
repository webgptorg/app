import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES, TERMINAL_RUN_STATUSES } from '@ptbk/engine-api';
import type { Run } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, skip } from '../../check';
import { CHAT_MESSAGE } from '../../fixtures/books';
import { checkFilter, checkStableWalk, requireCapability } from './capability-support';
import { SUITE, attempt } from './support';
import type { World } from './world';
import { REPLY_TIMEOUT_MS, createWorld } from './world';

const R = ENGINE_API_ROUTES;
const POLL_MS = 500;

const isTerminal = (run: Pick<Run, 'status'>): boolean => TERMINAL_RUN_STATUSES.includes(run.status);

/** A chat turn on the suite's own agent starts a run (C-07); this sends one and finds that run. */
async function chatRun(
    world: World,
): Promise<{ readonly run: Run; readonly chatId: string; readonly messageId: string }> {
    const agent = await world.agent();
    const chat = await world.chat();
    const sent = await world.owner.ok(R.sendChatMessage, {
        params: { chatId: chat.id },
        body: { content: CHAT_MESSAGE },
    });
    const { items } = await world.owner.ok(R.listRuns, { query: { agentId: agent.id, source: 'web', limit: 100 } });
    const run = items.find(({ messageId }) => messageId === sent.replyMessageId);
    if (run === undefined) skip('the engine started no run for a chat turn');
    return { run, chatId: chat.id, messageId: sent.replyMessageId };
}

/** Reads the reply to its end, so the run behind it can finish. */
async function finishReply(world: World, chatId: string, messageId: string): Promise<void> {
    await world.owner.stream(
        R.streamChatReply,
        { params: { chatId, messageId } },
        { maxMs: REPLY_TIMEOUT_MS, until: ({ event }) => event.type !== 'delta' },
    );
}

async function untilTerminal(world: World, runId: string): Promise<Run | null> {
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const run = await world.owner.ok(R.getRun, { params: { runId } });
        if (isTerminal(run)) return run;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return null;
}

export const RUN_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.runs.paging',
        suite: SUITE,
        title: 'GET /runs pages without gaps or duplicates, and its filters list only matching runs',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.runs);
            const findings = new Findings();
            // Runs keep changing status, but nothing queued before now joins or leaves this oldest-first list.
            const to = new Date().toISOString();
            await attempt(findings, () => checkStableWalk(world, findings, R.listRuns, { sort: 'queuedAt', to }));
            await attempt(findings, async () => {
                const failed = await world.owner.ok(R.listRuns, { query: { status: 'failed', limit: 50 } });
                checkFilter(findings, R.listRuns, 'status=failed', failed.items, ({ status }) => status === 'failed');
                const [sample] = (await world.owner.ok(R.listRuns, { query: { limit: 1 } })).items;
                if (sample === undefined) return;
                const byAgent = await world.owner.ok(R.listRuns, { query: { agentId: sample.agentId, limit: 50 } });
                checkFilter(
                    findings,
                    R.listRuns,
                    'agentId',
                    byAgent.items,
                    ({ agentId }) => agentId === sample.agentId,
                );
                const bySource = await world.owner.ok(R.listRuns, { query: { source: sample.source, limit: 50 } });
                checkFilter(findings, R.listRuns, 'source', bySource.items, ({ source }) => source === sample.source);
                if (!bySource.items.some(({ id }) => id === sample.id)) {
                    findings.add('GET /runs: filtering by a run’s own source leaves the run out');
                }
            });
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.runs.cancel-idempotent',
        suite: SUITE,
        title: 'Cancelling a run twice is one request (202, same cancelRequestedAt); once it finished, 409 run-finished',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.runs);
            const findings = new Findings();
            const { run, chatId, messageId } = await chatRun(world);
            const params = { runId: run.id };
            const first = await world.owner.call(R.cancelRun, { params });
            if (first.kind === 'ok') {
                if (first.data.cancelRequestedAt === null) {
                    findings.add('POST /runs/{runId}/cancel: the run has no cancelRequestedAt');
                }
                const second = await world.owner.call(R.cancelRun, { params });
                if (second.kind === 'ok') {
                    if (second.data.cancelRequestedAt !== first.data.cancelRequestedAt) {
                        findings.add('POST /runs/{runId}/cancel: a second cancel moved cancelRequestedAt');
                    }
                } else if (
                    second.problem.code !== 'run-finished' ||
                    !isTerminal(await world.owner.ok(R.getRun, { params }))
                ) {
                    findings.add(`POST /runs/{runId}/cancel: a second cancel got ${second.problem.code}`);
                }
            } else if (first.problem.code !== 'run-finished') {
                findings.add(`POST /runs/{runId}/cancel: got ${first.problem.code} for a run in progress`);
            }
            await attempt(findings, () => finishReply(world, chatId, messageId));
            const ended = await untilTerminal(world, run.id);
            if (ended === null) {
                findings.add('GET /runs/{runId}: the run never finished after its reply did');
                return findings.outcome();
            }
            await attempt(findings, async () => {
                await world.owner.problem(R.cancelRun, { params }, 'run-finished');
            });
            const after = await world.owner.ok(R.getRun, { params });
            if (after.status !== ended.status)
                findings.add('POST /runs/{runId}/cancel: a refused cancel changed the run');
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.runs.retry-only-failed',
        suite: SUITE,
        title: 'Retrying is refused (409 run-not-retryable) for anything but a failed run, which gets a linked new run',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.runs);
            const findings = new Findings();
            const notFailed = await world.owner.ok(R.listRuns, { query: { status: 'completed,cancelled', limit: 1 } });
            const done = notFailed.items[0];
            if (done !== undefined) {
                await attempt(findings, async () => {
                    await world.owner.problem(R.retryRun, { params: { runId: done.id } }, 'run-not-retryable');
                    const retries = await world.owner.ok(R.listRuns, { query: { limit: 100 } });
                    if (retries.items.some(({ retryOf }) => retryOf === done.id)) {
                        findings.add(`POST /runs/{runId}/retry: a refused retry of a ${done.status} run created one`);
                    }
                });
            }
            const [failed] = (await world.owner.ok(R.listRuns, { query: { status: 'failed', limit: 1 } })).items;
            if (failed !== undefined) {
                await attempt(findings, async () => {
                    const retry = await world.owner.ok(R.retryRun, { params: { runId: failed.id } });
                    // A retry does real work on a real engine; ask it to stop again straight away.
                    ctx.resources.defer((signal) =>
                        world.owner.withSignal(signal).send(R.cancelRun, { params: { runId: retry.id } }),
                    );
                    if (retry.retryOf !== failed.id)
                        findings.add('POST /runs/{runId}/retry: retryOf does not name the run');
                    if (isTerminal(retry))
                        findings.add(`POST /runs/{runId}/retry: the new run is already ${retry.status}`);
                    if (retry.agentId !== failed.agentId)
                        findings.add('POST /runs/{runId}/retry: the retry runs another agent');
                });
            }
            if (done === undefined && failed === undefined) skip('the engine has no finished run to retry');
            return findings.outcome();
        },
    },
];
