import type { TestChatEvent } from '../capabilities/test-chat';
import { createProblem } from '../problem';
import type { EngineApiStreamItem } from '../route';
import { checkBook } from './book';
import { fail, liveAgent, ok } from './kit';
import type { HandlerContext, Handlers, ScriptedReply } from './kit';

/**
 * The draft's reply, generated while it is read and from nothing but the request: no chat, message, run or event is
 * created, so nothing outlives the stream. An abort of the request stops the generation between chunks.
 */
async function* streamTestReply(
    ctx: HandlerContext,
    script: ScriptedReply,
): AsyncIterable<EngineApiStreamItem<TestChatEvent>> {
    let content = '';
    let id: string | null = null;
    try {
        for (const [index, chunk] of script.chunks.entries()) {
            const text = typeof chunk === 'string' ? chunk : chunk.text;
            const delayMs = typeof chunk === 'string' ? 0 : Math.max(0, chunk.delayMs ?? 0);
            if (delayMs > 0) await ctx.replies.sleep(delayMs, ctx.signal);
            else await Promise.resolve();
            ctx.signal.throwIfAborted();
            content += text;
            id = String(index + 1);
            yield { id, event: { type: 'delta', seq: index + 1, text } };
        }
    } catch {
        // The reader went away; there is nobody to tell and nothing to clean up.
        return;
    }
    yield script.outcome === 'failed'
        ? { id, event: { type: 'failed', problem: createProblem('reply-failed') } }
        : { id, event: { type: 'completed', content } };
}

export const TEST_CHAT_HANDLERS: Pick<Handlers, 'testAgentDraft'> = {
    testAgentDraft: ({ params, body }, ctx) => {
        const found = liveAgent(ctx, params.agentId);
        if (found.kind === 'problem') return found;
        const book = checkBook(body.book);
        if (book.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
            return fail('invalid-book', { diagnostics: book.diagnostics });
        }
        const last = body.messages.at(-1);
        const script = ctx.replyScript({
            agent: { ...found.data, name: book.name, profile: book.profile },
            content: last?.content ?? '',
            chatId: null,
            messageIndex: body.messages.length - 1,
        });
        return ok(streamTestReply(ctx, script));
    },
};
