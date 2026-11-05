import type { Message, ReplyStreamEvent } from '../chats';
import type { MessageId } from '../common';
import { createProblem } from '../problem';
import type { EngineApiStreamItem } from '../route';
import type { EngineContext, HandlerContext, ScriptedReply } from './kit';
import { advanceRun, runForMessage } from './runs';
import { settleMessage, touch } from './threads';

/** Stores the reply's script and, for a paced one, starts generating it right away. */
export function startReply(ctx: EngineContext, messageId: MessageId, script: ScriptedReply): void {
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
    touchThread(ctx, message.chatId);
    ctx.replies.notify(message.id);
    return true;
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
