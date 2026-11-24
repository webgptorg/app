import type { Message, ParticipantRef, ReplyStreamEvent } from '../chats';
import type { MessageId } from '../common';
import { createProblem } from '../problem';
import type { EngineApiStreamItem } from '../route';
import type { Agent } from '../agents';
import type { EngineContext, HandlerContext, HandlerResult, ReplyScript, ScriptedReply } from './kit';
import { fail, ok } from './kit';
import { blockingAiTool } from './ai-tools';
import { advanceRun, runForMessage } from './runs';
import type { ChatRecord } from './threads';
import { settleMessage, touch } from './threads';
import { REPLY_FAILED_CAUSE, addStep, beginTurn, endTurn, startText, toStep, turnWriting } from './turns';

export interface NewTurn {
    readonly author: ParticipantRef;
    readonly script: ScriptedReply;
    /** What the turn answers; a failed turn is attempted again with it. */
    readonly prompt: string;
    readonly rounds?: number;
    readonly choices?: readonly string[];
    /** Called once the reply message exists, before any text is generated. */
    readonly onReply?: (reply: Message) => void;
}

/**
 * An agent's turn: it is working from now on, goes through the script's steps, then writes its reply. Without delays
 * the steps are done at once and the reply waits to be streamed; with them the turn runs on its own. The caller
 * announces the start.
 */
export function startTurn(ctx: EngineContext, record: ChatRecord, turn: NewTurn): void {
    const working = beginTurn(ctx, record, {
        author: turn.author,
        prompt: turn.prompt,
        ...(turn.rounds === undefined ? {} : { rounds: turn.rounds }),
    });
    // The harness cannot answer without its sign-in: the turn fails before any step, naming the tool to sign in again.
    const blocked = blockingAiTool(ctx);
    if (blocked !== null) {
        const name = ctx.state.aiTools.tools.get(blocked)?.fake.name ?? blocked;
        endTurn(ctx, record, working, {
            kind: 'failed',
            cause: `${name} needs signing in again before agents can answer.`,
            aiToolId: blocked,
        });
        return;
    }
    const steps = (turn.script.steps ?? []).map((step) => ({ step: toStep(step), delayMs: step.delayMs }));
    const write = (announce: boolean): void => {
        const reply = startText(ctx, record, working, {
            content: '',
            status: 'streaming',
            ...(turn.choices === undefined ? {} : { choices: turn.choices }),
        });
        turn.onReply?.(reply);
        if (announce) touch(ctx, record);
        startReply(ctx, reply.id, turn.script);
    };
    if (steps.every(({ delayMs }) => delayMs === undefined)) {
        working.steps.push(...steps.map(({ step }) => step));
        write(false);
        return;
    }
    void (async () => {
        try {
            for (const { step, delayMs } of steps) {
                await ctx.replies.sleep(Math.max(0, delayMs ?? 0), new AbortController().signal);
                addStep(ctx, record, working, step);
            }
        } catch {
            // The injected sleep refused; the turn stays working, as an engine whose harness hung would.
            return;
        }
        write(true);
    })();
}

/** Stores the reply's script and, for a paced one, starts generating it right away. */
function startReply(ctx: EngineContext, messageId: MessageId, script: ScriptedReply): void {
    const chunks = script.chunks.map((chunk) =>
        typeof chunk === 'string'
            ? { text: chunk, delayMs: 0 }
            : { text: chunk.text, delayMs: Math.max(0, chunk.delayMs ?? 0) },
    );
    const paced = script.chunks.some((chunk) => typeof chunk !== 'string' && chunk.delayMs !== undefined);
    const record = { chunks, outcome: script.outcome ?? 'completed', paced, generated: 0, stop: new AbortController() };
    ctx.state.replies.set(messageId, record);
    if (paced) void generate(ctx, messageId);
}

/** Marks a streaming reply cancelled and stops its generation; `false` once the reply had already finished. */
export function cancelReply(ctx: EngineContext, message: Message): boolean {
    if (message.status === 'cancelled') return true;
    if (message.status !== 'streaming') return false;
    ctx.state.messages.set(message.id, { ...message, status: 'cancelled' });
    ctx.state.replies.get(message.id)?.stop.abort();
    const run = runForMessage(ctx, message.id);
    if (run) advanceRun(ctx, run.id, { status: 'cancelled' });
    endTurnOf(ctx, message, { kind: 'cancelled' });
    touchThread(ctx, message.chatId);
    ctx.replies.notify(message.id);
    return true;
}

function endTurnOf(ctx: EngineContext, message: Message, outcome: Parameters<typeof endTurn>[3]): void {
    const thread = ctx.state.chats.get(message.chatId);
    const working = thread && turnWriting(thread, message.id);
    if (thread && working) endTurn(ctx, thread, working, outcome);
}

async function generate(ctx: EngineContext, messageId: MessageId): Promise<void> {
    const record = ctx.state.replies.get(messageId);
    if (!record) return;
    try {
        for (const chunk of record.chunks) {
            await ctx.replies.sleep(chunk.delayMs, record.stop.signal);
            if (ctx.state.messages.get(messageId)?.status !== 'streaming') return;
            record.generated++;
            ctx.replies.notify(messageId);
        }
        finish(ctx, messageId);
    } catch {
        // Aborted by the cancel route, which already ended the reply.
    }
}

function finish(ctx: EngineContext, messageId: MessageId): void {
    const message = ctx.state.messages.get(messageId);
    const reply = ctx.state.replies.get(messageId);
    if (message?.status !== 'streaming' || !reply) return;
    const content = reply.chunks.map(({ text }) => text).join('');
    const finished: Message = { ...message, content, status: reply.outcome === 'failed' ? 'failed' : 'completed' };
    ctx.state.messages.set(messageId, finished);
    const run = runForMessage(ctx, messageId);
    if (run) {
        advanceRun(
            ctx,
            run.id,
            finished.status === 'failed'
                ? { status: 'failed', error: { code: 'reply-failed', summary: 'The reply failed.' } }
                : { status: 'completed' },
        );
    }
    const thread = ctx.state.chats.get(finished.chatId);
    if (thread) settleMessage(ctx, thread, finished);
    endTurnOf(
        ctx,
        finished,
        finished.status === 'failed' ? { kind: 'failed', cause: REPLY_FAILED_CAUSE } : { kind: 'completed' },
    );
    touchThread(ctx, finished.chatId);
    ctx.replies.notify(messageId);
}

function touchThread(ctx: EngineContext, chatId: string): void {
    const thread = ctx.state.chats.get(chatId);
    if (thread) touch(ctx, thread);
}

/**
 * A reply as SSE. Terminal events carry no SSE id of their own, so they report the last delta's, exactly as an SSE
 * parser would. Closing the stream ends only this stream; `Last-Event-ID` resumes after that delta.
 */
export function streamReply(
    ctx: HandlerContext,
    messageId: MessageId,
    lastEventId: string | null,
): AsyncIterable<EngineApiStreamItem<ReplyStreamEvent>> {
    const resumeAfter = lastEventId === null ? 0 : Number.parseInt(lastEventId, 10) || 0;
    return ctx.state.replies.get(messageId)?.paced === true
        ? streamPaced(ctx, messageId, resumeAfter)
        : streamUnpaced(ctx, messageId, resumeAfter);
}

/** An unpaced reply has no model behind it: reading the stream to its end completes it. */
async function* streamUnpaced(
    ctx: HandlerContext,
    messageId: MessageId,
    resumeAfter: number,
): AsyncIterable<EngineApiStreamItem<ReplyStreamEvent>> {
    const reply = ctx.state.replies.get(messageId);
    if (!reply) return;
    let id: string | null = null;
    for (let index = resumeAfter; index < reply.chunks.length; index++) {
        if (ctx.state.messages.get(messageId)?.status === 'cancelled') break;
        const seq = index + 1;
        id = String(seq);
        yield { id, event: { type: 'delta', seq, text: reply.chunks[index]?.text ?? '' } };
        await Promise.resolve();
    }
    finish(ctx, messageId);
    const final = ctx.state.messages.get(messageId);
    if (final) yield terminal(final, id);
}

async function* streamPaced(
    ctx: HandlerContext,
    messageId: MessageId,
    resumeAfter: number,
): AsyncIterable<EngineApiStreamItem<ReplyStreamEvent>> {
    let index = resumeAfter;
    let id: string | null = null;
    for (;;) {
        const reply = ctx.state.replies.get(messageId);
        const message = ctx.state.messages.get(messageId);
        if (!reply || !message) return;
        if (message.status !== 'cancelled' && index < reply.generated) {
            const seq = index + 1;
            id = String(seq);
            yield { id, event: { type: 'delta', seq, text: reply.chunks[index]?.text ?? '' } };
            index++;
            continue;
        }
        if (message.status !== 'streaming') {
            yield terminal(message, id);
            return;
        }
        await ctx.replies.next(messageId, ctx.signal);
    }
}

function terminal(message: Message, id: string | null): EngineApiStreamItem<ReplyStreamEvent> {
    switch (message.status) {
        case 'cancelled':
            return { id, event: { type: 'failed', problem: createProblem('cancelled') } };
        case 'failed':
            return { id, event: { type: 'failed', problem: createProblem('reply-failed') } };
        case 'completed':
        case 'streaming':
            return { id, event: { type: 'completed', message } };
    }
}

/**
 * Attempts a thread's failed reply now, as the engine does by itself at `recheck.nextAt`. Asking again while the
 * attempt runs changes nothing; without a recheck there is nothing to retry. A recheck whose agent is gone is dropped.
 */
export function retry(
    ctx: EngineContext,
    record: ChatRecord,
    replyScript: ReplyScript,
    onReply?: (agent: Agent, reply: Message, prompt: string) => void,
): HandlerResult<null> {
    const recheck = record.recheck;
    if (recheck === null) {
        return record.working.some(({ rounds }) => rounds > 0)
            ? ok(null)
            : fail('nothing-to-retry', { detail: 'No failed reply waits in this thread.' });
    }
    record.recheck = null;
    const agent = recheck.author.kind === 'agent' ? ctx.state.agents.get(recheck.author.key)?.agent : undefined;
    if (!agent || agent.deletedAt !== null) {
        touch(ctx, record);
        return fail('nothing-to-retry', { detail: 'The agent whose reply failed is gone.' });
    }
    startTurn(ctx, record, {
        author: recheck.author,
        script: replyScript({ agent, content: recheck.prompt, chatId: record.id, messageIndex: record.messageCount }),
        prompt: recheck.prompt,
        rounds: recheck.rounds,
        ...(onReply === undefined
            ? {}
            : {
                  onReply: (reply: Message) => {
                      onReply(agent, reply, recheck.prompt);
                  },
              }),
    });
    touch(ctx, record);
    return ok(null);
}
