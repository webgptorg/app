import { z } from 'zod';

import { AgentParams, BookSource } from '../agents';
import { MESSAGE_ROLES } from '../chats';
import { ProblemDetails } from '../common';
import { MAX_MESSAGE_LENGTH, MAX_TEST_CHAT_MESSAGES, MAX_TEST_CHAT_TRANSCRIPT_LENGTH } from '../constants';
import { defineRoute } from '../route';
import { KNOWN_CAPABILITIES } from './capability';

/** One turn of a test conversation, as the UI holds it; the engine keeps none of them. */
export const TestChatTurn = z.strictObject({
    role: z.enum(MESSAGE_ROLES),
    content: z.string().min(1).max(MAX_MESSAGE_LENGTH),
});
export type TestChatTurn = z.infer<typeof TestChatTurn>;

function transcriptLength(turns: readonly TestChatTurn[]): number {
    return turns.reduce((total, { content }) => total + content.length, 0);
}

/**
 * The unsaved book as typed and the whole conversation so far, oldest first, ending with the member's new message.
 * The engine is stateless between turns: every request carries everything the reply depends on.
 */
export const TestChatBody = z.strictObject({
    book: BookSource,
    messages: z
        .array(TestChatTurn)
        .min(1)
        .max(MAX_TEST_CHAT_MESSAGES)
        .refine((turns) => turns.at(-1)?.role === 'user', { message: 'The last message must be the member’s' })
        .refine((turns) => transcriptLength(turns) <= MAX_TEST_CHAT_TRANSCRIPT_LENGTH, {
            message: `The messages may hold at most ${String(MAX_TEST_CHAT_TRANSCRIPT_LENGTH)} characters together`,
        }),
});
export type TestChatBody = z.infer<typeof TestChatBody>;

/**
 * A test reply. `delta`s carry `seq` (1, 2, ...) as the SSE id, then exactly one `completed` with the whole reply or
 * one `failed`. Nothing is stored, so there is no resume: a dropped stream is a lost reply, and the UI sends again.
 * Like any agent output, `text` and `content` are untrusted and rendered as data.
 */
export const TestChatEvent = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('delta'), seq: z.int().min(1), text: z.string() }),
    z.strictObject({ type: z.literal('completed'), content: z.string() }),
    z.strictObject({ type: z.literal('failed'), problem: ProblemDetails }),
]);
export type TestChatEvent = z.infer<typeof TestChatEvent>;

export const TEST_CHAT_ROUTES = {
    testAgentDraft: defineRoute({
        id: 'testAgentDraft',
        method: 'POST',
        path: '/agents/{agentId}/test-chat',
        summary: "Stream the agent's reply to a test conversation run against an unsaved book, storing nothing",
        description:
            'The reply comes from the book in the body, not the saved one. The engine stores nothing: no chat, message, ' +
            'revision, run or activity, and closing the stream stops the reply. A book with an error diagnostic is ' +
            'refused before anything streams.',
        permission: 'agents.write',
        capability: KNOWN_CAPABILITIES.testChat,
        params: AgentParams,
        body: { kind: 'json', schema: TestChatBody },
        responses: { 200: { kind: 'sse', event: TestChatEvent } },
        problems: ['invalid-book', 'agent-deleted'],
    }),
} as const;
