import { z } from 'zod';

import { AgentParams } from './agents';
import { RUN_SOURCES, RunSource } from './capabilities/runs';
import { AgentId, ChatId, Cursor, MemberId, MessageId, PageQuery, ProblemDetails, Timestamp, pageOf } from './common';
import { MAX_CHAT_PREVIEW_LENGTH, MAX_MESSAGE_LENGTH } from './constants';
import { defineRoute } from './route';
import { toTolerant } from './tolerant';

/**
 * What started a chat, with the same values as a run's source (`runs@1`): `web` for the engine UI and public agent
 * pages, `api` for API clients, and `email`, `schedule`, `member`, `goal`, `webhook` for chats the engine opens itself.
 */
export const ChatSource = RunSource;
export type ChatSource = RunSource;

export const Chat = z.strictObject({
    id: ChatId,
    agentId: AgentId,
    title: z.string().max(256),
    source: ChatSource,
    /**
     * The member who started the chat; `null` when no member did: a public visitor of a public agent (`web`), an API
     * client (`api`), or the engine itself (`email`, `schedule`, `goal`, `webhook`).
     */
    createdBy: MemberId.nullable(),
    createdAt: Timestamp,
    /** Moves with every change to the chat: a new message, or a reply finishing. */
    updatedAt: Timestamp,
    /** Every message in the chat, of both roles, including a reply still streaming. */
    messageCount: z.int().min(0),
    /** When the newest message was created; `null` for a chat without messages. */
    lastMessageAt: Timestamp.nullable(),
    /**
     * The chat's first user message as plain text, with whitespace runs collapsed to one space and cut to
     * `MAX_CHAT_PREVIEW_LENGTH`; `null` until there is one. User content: render it as text only.
     */
    preview: z.string().max(MAX_CHAT_PREVIEW_LENGTH).nullable(),
});
export type Chat = z.infer<typeof Chat>;
export const ChatPage = pageOf(Chat);

const KNOWN_CHAT_SOURCES: ReadonlySet<string> = new Set(RUN_SOURCES);

/**
 * A chat as the client reads it: a `source` this contract does not know yet (a newer engine's) reads as `unknown`, so
 * the UI shows it as such instead of failing the whole list.
 */
export const ChatReader = toTolerant(
    Chat.extend({
        source: z
            .string()
            .max(64)
            .transform((source): ChatSource | 'unknown' =>
                KNOWN_CHAT_SOURCES.has(source) ? (source as ChatSource) : 'unknown',
            ),
    }),
);
export type ReadChat = z.output<typeof ChatReader>;
export const ChatPageReader = z.object({ items: z.array(ChatReader), nextCursor: Cursor.nullable() });

export const CreateChatBody = z.strictObject({ title: z.string().max(256).optional() });

export const MESSAGE_ROLES = ['user', 'agent'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export const MESSAGE_STATUSES = ['streaming', 'completed', 'failed', 'cancelled'] as const;

/** Agent output is untrusted text: the UI renders it as data, never as markup or code. */
export const Message = z.strictObject({
    id: MessageId,
    chatId: ChatId,
    role: z.enum(MESSAGE_ROLES),
    content: z.string(),
    status: z.enum(MESSAGE_STATUSES),
    /** The member who wrote a `user` message; `null` for agent replies and for someone who is not a member. */
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

export const AgentChatListQuery = PageQuery.extend({ source: ChatSource.optional() });

export const ChatListQuery = AgentChatListQuery.extend({
    agentId: AgentId.optional(),
    /** Matches the title, case-insensitively. */
    q: z.string().min(1).max(256).optional(),
});

const oneChat = { kind: 'json', schema: Chat, read: ChatReader } as const;
const chatPage = { 200: { kind: 'json', schema: ChatPage, read: ChatPageReader } } as const;

export const CHAT_ROUTES = {
    listChats: defineRoute({
        id: 'listChats',
        method: 'GET',
        path: '/chats',
        summary: 'List every chat the member can see, across agents, most recently updated first',
        permission: 'chats.read',
        query: ChatListQuery,
        responses: chatPage,
    }),
    listAgentChats: defineRoute({
        id: 'listAgentChats',
        method: 'GET',
        path: '/agents/{agentId}/chats',
        summary: "List an agent's chats, most recently updated first",
        permission: 'chats.read',
        params: AgentParams,
        query: AgentChatListQuery,
        responses: chatPage,
    }),
    createChat: defineRoute({
        id: 'createChat',
        method: 'POST',
        path: '/agents/{agentId}/chats',
        summary: 'Start a chat with an agent',
        permission: 'chats.write',
        params: AgentParams,
        body: { kind: 'json', schema: CreateChatBody },
        responses: { 201: oneChat },
        problems: ['agent-deleted'],
    }),
    getChat: defineRoute({
        id: 'getChat',
        method: 'GET',
        path: '/chats/{chatId}',
        summary: 'Get a chat',
        permission: 'chats.read',
        params: ChatParams,
        responses: { 200: oneChat },
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
