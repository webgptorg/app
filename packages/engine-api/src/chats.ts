import { z } from 'zod';

import { AgentParams } from './agents';
import { AgentId, ChatId, MemberId, MessageId, PageQuery, ProblemDetails, Timestamp, pageOf } from './common';
import { MAX_MESSAGE_LENGTH } from './constants';
import { defineRoute } from './route';

export const Chat = z.strictObject({
    id: ChatId,
    agentId: AgentId,
    title: z.string().max(256),
    createdBy: MemberId,
    createdAt: Timestamp,
    updatedAt: Timestamp,
});
export type Chat = z.infer<typeof Chat>;
export const ChatPage = pageOf(Chat);

export const CreateChatBody = z.strictObject({ title: z.string().max(256).optional() });

export const MESSAGE_ROLES = ['user', 'agent'] as const;
export const MESSAGE_STATUSES = ['streaming', 'completed', 'failed', 'cancelled'] as const;

/** Agent output is untrusted text: the UI renders it as data, never as markup or code. */
export const Message = z.strictObject({
    id: MessageId,
    chatId: ChatId,
    role: z.enum(MESSAGE_ROLES),
    content: z.string(),
    status: z.enum(MESSAGE_STATUSES),
    /** The member who wrote a `user` message; `null` for agent replies. */
    createdBy: MemberId.nullable(),
    createdAt: Timestamp,
});
export type Message = z.infer<typeof Message>;
export const MessagePage = pageOf(Message);

export const ChatParams = z.strictObject({ chatId: ChatId });
export const ChatMessageParams = z.strictObject({ chatId: ChatId, messageId: MessageId });

export const SendMessageBody = z.strictObject({ content: z.string().min(1).max(MAX_MESSAGE_LENGTH) });
export const SendMessageResult = z.strictObject({ userMessage: Message, replyMessageId: MessageId });

/**
 * A streamed reply. Each `delta` carries its `seq` (1, 2, ...) as the SSE id, so a stream resumed with
 * `Last-Event-ID: <seq>` continues after it. The stream ends after exactly one `completed` or `failed`.
 */
export const ReplyStreamEvent = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('delta'), seq: z.int().min(1), text: z.string() }),
    z.strictObject({ type: z.literal('completed'), message: Message }),
    z.strictObject({ type: z.literal('failed'), problem: ProblemDetails }),
]);
export type ReplyStreamEvent = z.infer<typeof ReplyStreamEvent>;

export const CHAT_ROUTES = {
    listAgentChats: defineRoute({
        id: 'listAgentChats',
        method: 'GET',
        path: '/agents/{agentId}/chats',
        summary: "List an agent's chats, most recently updated first",
        permission: 'chats.read',
        params: AgentParams,
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: ChatPage } },
    }),
    createChat: defineRoute({
        id: 'createChat',
        method: 'POST',
        path: '/agents/{agentId}/chats',
        summary: 'Start a chat with an agent',
        permission: 'chats.write',
        params: AgentParams,
        body: { kind: 'json', schema: CreateChatBody },
        responses: { 201: { kind: 'json', schema: Chat } },
        problems: ['agent-deleted'],
    }),
    getChat: defineRoute({
        id: 'getChat',
        method: 'GET',
        path: '/chats/{chatId}',
        summary: 'Get a chat',
        permission: 'chats.read',
        params: ChatParams,
        responses: { 200: { kind: 'json', schema: Chat } },
    }),
    listChatMessages: defineRoute({
        id: 'listChatMessages',
        method: 'GET',
        path: '/chats/{chatId}/messages',
        summary: 'List messages, newest first',
        permission: 'chats.read',
        params: ChatParams,
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: MessagePage } },
    }),
    sendChatMessage: defineRoute({
        id: 'sendChatMessage',
        method: 'POST',
        path: '/chats/{chatId}/messages',
        summary: 'Send a message; the reply is streamed from its own route',
        permission: 'chats.write',
        params: ChatParams,
        body: { kind: 'json', schema: SendMessageBody },
        responses: { 202: { kind: 'json', schema: SendMessageResult } },
        problems: ['agent-deleted'],
    }),
    streamChatReply: defineRoute({
        id: 'streamChatReply',
        method: 'GET',
        path: '/chats/{chatId}/messages/{messageId}/stream',
        summary: 'Stream a reply as server-sent events; resumes after `Last-Event-ID`',
        permission: 'chats.read',
        params: ChatMessageParams,
        responses: { 200: { kind: 'sse', event: ReplyStreamEvent } },
    }),
    cancelChatReply: defineRoute({
        id: 'cancelChatReply',
        method: 'POST',
        path: '/chats/{chatId}/messages/{messageId}/cancel',
        summary: 'Stop a reply in progress (idempotent); its stream then ends with `failed` and code `cancelled`',
        permission: 'chats.write',
        params: ChatMessageParams,
        responses: { 200: { kind: 'json', schema: Message } },
        problems: ['reply-finished'],
    }),
} as const;
