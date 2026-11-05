import { z } from 'zod';

import { AgentParams } from './agents';
import { AgentId, ChatId, Cursor, MemberId, MessageId, PageQuery, ProblemDetails, Timestamp, pageOf } from './common';
import { MAX_CHAT_PREVIEW_LENGTH, MAX_MESSAGE_LENGTH } from './constants';
import { defineRoute } from './route';
import { openEnum, toTolerant } from './tolerant';

/** Longest name of a participant, as the engine shows it. */
export const MAX_PARTICIPANT_NAME_LENGTH = 256;
/** Most predefined answers an agent offers with one question, and the longest one (the engine's own limits). */
export const MAX_MESSAGE_CHOICES = 50;
export const MAX_MESSAGE_CHOICE_LENGTH = 1000;
/** Most messages one `seen` call names: the ones on screen. */
export const MAX_SEEN_MESSAGES = 100;

/**
 * The human side of the project. The engine has one User: every member speaks as it, and which member sent a message
 * is the message's `createdBy`.
 */
export const USER_PARTICIPANT_KEY = 'user';

export const PARTICIPANT_KINDS = ['agent', 'user'] as const;

const participantFields = {
    kind: z.enum(PARTICIPANT_KINDS),
    /** An agent's `AgentId`, or `user` for the User. */
    key: z.string().min(1).max(512),
} as const;

function keyFitsKind(participant: { readonly kind: string; readonly key: string }): boolean {
    return participant.kind === 'user'
        ? participant.key === USER_PARTICIPANT_KEY
        : AgentId.safeParse(participant.key).success;
}
const KEY_MISMATCH = { message: "an agent's key is its AgentId and the User's is `user`", path: ['key'] };

/**
 * Who speaks in a thread: any agent (ordinary, core such as Chatter, the built-in Expert) or the User. The User never
 * speaks as an agent and an agent never as the User.
 */
export const ParticipantRef = z.strictObject(participantFields).refine(keyFitsKind, KEY_MISMATCH);
export type ParticipantRef = z.infer<typeof ParticipantRef>;

/** A thread member with the name to show; untrusted text, rendered as text only. */
export const Participant = z
    .strictObject({ ...participantFields, name: z.string().min(1).max(MAX_PARTICIPANT_NAME_LENGTH) })
    .refine(keyFitsKind, KEY_MISMATCH);
export type Participant = z.infer<typeof Participant>;

/** A kind a newer engine adds reads as `unknown`, so the UI shows the author without failing the thread. */
const ParticipantRefReader = z.object({ kind: openEnum(PARTICIPANT_KINDS), key: participantFields.key });
const ParticipantReader = ParticipantRefReader.extend({ name: z.string().min(1).max(MAX_PARTICIPANT_NAME_LENGTH) });
export type ReadParticipantRef = z.output<typeof ParticipantRefReader>;
export type ReadParticipant = z.output<typeof ParticipantReader>;

/**
 * The engine's `CHAT STATUS`: a new thread is `open`; `waiting-for-user` while an agent waits on the User; `resolved`
 * when the conversation is done. The last transition wins; each one is also a `status` entry in the thread.
 */
export const CHAT_STATUSES = ['open', 'waiting-for-user', 'resolved'] as const;
export const ChatStatus = z.enum(CHAT_STATUSES);
export type ChatStatus = z.infer<typeof ChatStatus>;

const questionFields = {
    /** The attention occurrence; a later ping in another message is a new one. */
    id: z.string().min(1).max(512),
    messageId: MessageId,
    seen: z.boolean(),
} as const;

/**
 * An outstanding question to the User: an agent message with an active `+@User`, not yet answered or withdrawn. Seen
 * and answered are separate facts: `seen` only means someone displayed it, and it keeps waiting until a saved answer
 * (or its agent withdrawing it) removes it from the list.
 */
export const ChatQuestion = z.strictObject({ ...questionFields, author: ParticipantRef });
export type ChatQuestion = z.infer<typeof ChatQuestion>;

const chatFields = {
    id: ChatId,
    /** The latest `CHAT TITLE`, else the thread's name. User and agent content: text only. */
    title: z.string().max(256),
    createdAt: Timestamp,
    /** Moves with every change: a new entry, a reply finishing, a question answered or seen. */
    updatedAt: Timestamp,
    /** Every message, of every author, including one still streaming. */
    messageCount: z.int().min(0),
    /** When the newest message was created; `null` without messages. */
    lastMessageAt: Timestamp.nullable(),
    /**
     * The newest message as plain text, whitespace runs collapsed to one space, cut to `MAX_CHAT_PREVIEW_LENGTH`;
     * `null` until there is one with text. Untrusted content: text only.
     */
    preview: z.string().max(MAX_CHAT_PREVIEW_LENGTH).nullable(),
    /** Messages not written by the User since the calling member last marked the thread read. */
    unread: z.int().min(0),
} as const;

/**
 * A thread: the engine's `CHAT` Book. Members join over time (agents as Chatter brings them in, the User when it
 * writes or is asked something), and the title changes with the topic. A thread may have no User at all (agents
 * talking, or a one-agent report). Nobody owns it: every member with `chats.write` may write in it.
 */
export const Chat = z.strictObject({
    ...chatFields,
    status: ChatStatus,
    /** In the order they joined; the first agent is the thread's main agent. */
    members: z.array(Participant),
    /** Outstanding questions to the User, oldest first. Non-empty means the thread needs the User. */
    questions: z.array(ChatQuestion),
});
export type Chat = z.infer<typeof Chat>;
export const ChatPage = pageOf(Chat);

export const ChatReader = toTolerant(
    z.object({
        ...chatFields,
        status: openEnum(CHAT_STATUSES),
        members: z.array(ParticipantReader),
        questions: z.array(z.object({ ...questionFields, author: ParticipantRefReader })),
    }),
);
export type ReadChat = z.output<typeof ChatReader>;
export const ChatPageReader = z.object({ items: z.array(ChatReader), nextCursor: Cursor.nullable() });

/**
 * A client's key for one mutation, so a retry after a lost response cannot do it twice: the engine answers a repeated
 * key with the original result, and refuses it with 409 `request-key-reused` for a different request. Generate one
 * per intended action, never per attempt.
 */
export const RequestKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

export const CreateChatBody = z.strictObject({
    /** The thread's first agent; without one the engine starts it with Chatter (409 `chatter-missing` if it has none). */
    agentId: AgentId.optional(),
    title: z.string().min(1).max(256).optional(),
    requestKey: RequestKey.optional(),
});

export const MESSAGE_STATUSES = ['streaming', 'completed', 'failed', 'cancelled'] as const;

const messageFields = {
    type: z.literal('message'),
    /** Assigned by the engine (today `<chat>#<position>`); opaque. */
    id: MessageId,
    chatId: ChatId,
    /** While `streaming`, what is in so far; the message's stream carries the rest. */
    content: z.string(),
    status: z.enum(MESSAGE_STATUSES),
    /** The member who sent a User message; `null` for agent messages and for anyone who is not a member. */
    createdBy: MemberId.nullable(),
    createdAt: Timestamp,
    /** Predefined answers an agent offers; empty for none. Answering is an ordinary message with `replyTo`. */
    choices: z.array(z.string().min(1).max(MAX_MESSAGE_CHOICE_LENGTH)).max(MAX_MESSAGE_CHOICES),
} as const;

/** Content is untrusted text from people and agents: the UI renders it as data, never as markup or code. */
export const Message = z.strictObject({
    ...messageFields,
    /** The real author, always a member who joined in an earlier entry. */
    author: ParticipantRef,
});
export type Message = z.infer<typeof Message>;

const eventFields = { id: z.string().min(1).max(512), chatId: ChatId, createdAt: Timestamp } as const;

/** A participant joined (`CHAT MEMBER`); always before that participant's first message. */
export const JoinedEntry = z.strictObject({ type: z.literal('joined'), ...eventFields, participant: Participant });
/** The title changed (`CHAT TITLE`). */
export const TitledEntry = z.strictObject({ type: z.literal('titled'), ...eventFields, title: z.string().max(256) });
/** The status changed (`CHAT STATUS`). */
export const StatusEntry = z.strictObject({ type: z.literal('status'), ...eventFields, status: ChatStatus });

/** One item of a thread, in the order the engine recorded it. */
export const ChatEntry = z.discriminatedUnion('type', [Message, JoinedEntry, TitledEntry, StatusEntry]);
export type ChatEntry = z.infer<typeof ChatEntry>;
export const ChatEntryPage = pageOf(ChatEntry);

/** A status or author kind a newer engine adds reads as `unknown`, so one message never fails the whole thread. */
const MessageReader = z.object({
    ...messageFields,
    status: openEnum(MESSAGE_STATUSES),
    author: ParticipantRefReader,
});
export type ReadMessage = z.output<typeof MessageReader>;
const tolerantEntry = toTolerant(
    z.discriminatedUnion('type', [
        MessageReader,
        z.object({ type: z.literal('joined'), ...eventFields, participant: ParticipantReader }),
        z.object({ type: z.literal('titled'), ...eventFields, title: z.string().max(256) }),
        z.object({ type: z.literal('status'), ...eventFields, status: openEnum(CHAT_STATUSES) }),
    ]),
);
export type ReadChatEntry = z.output<typeof tolerantEntry>;
const KNOWN_ENTRY_TYPES: ReadonlySet<string> = new Set(['message', 'joined', 'titled', 'status']);

/** An entry of a type a newer engine added is skipped, so it never fails the whole page. */
export const ChatEntryPageReader = z.object({
    items: z.array(z.unknown()).transform((items, ctx): ReadChatEntry[] => {
        const read: ReadChatEntry[] = [];
        for (const [index, raw] of items.entries()) {
            const type =
                typeof raw === 'object' && raw !== null
                    ? (raw as Readonly<Record<string, unknown>>)['type']
                    : undefined;
            if (typeof type === 'string' && !KNOWN_ENTRY_TYPES.has(type)) continue;
            const entry = tolerantEntry.safeParse(raw);
            if (entry.success) read.push(entry.data);
            else {
                for (const issue of entry.error.issues) {
                    ctx.addIssue({ code: 'custom', message: issue.message, path: [index, ...issue.path] });
                }
            }
        }
        return read;
    }),
    nextCursor: Cursor.nullable(),
});

export const ChatParams = z.strictObject({ chatId: ChatId });
export const ChatMessageParams = z.strictObject({ chatId: ChatId, messageId: MessageId });

export const SendMessageBody = z.strictObject({
    content: z.string().min(1).max(MAX_MESSAGE_LENGTH),
    requestKey: RequestKey.optional(),
    /**
     * The question this answers. Saving the answer clears that question at once, before any agent reads it. Without
     * it the engine routes the message itself, and it answers a question only when exactly one waits.
     */
    replyTo: MessageId.optional(),
});
/** The saved message. Replies arrive as entries of their own (`chat.changed` announces them), from whoever answers. */
export const SendMessageResult = z.strictObject({ message: Message });
export const SendMessageResultReader = toTolerant(z.object({ message: MessageReader }));

export const MarkSeenBody = z.strictObject({
    /** Messages actually displayed to the member; listing or preloading a thread is not seeing it. */
    messageIds: z.array(MessageId).min(1).max(MAX_SEEN_MESSAGES),
});

/**
 * A message as its author writes it. Each `delta` carries its `seq` (1, 2, ...) as the SSE id, so a stream resumed
 * with `Last-Event-ID: <seq>` continues after it. The stream ends after exactly one `completed` or `failed`.
 */
export const ReplyStreamEvent = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('delta'), seq: z.int().min(1), text: z.string() }),
    z.strictObject({ type: z.literal('completed'), message: Message }),
    z.strictObject({ type: z.literal('failed'), problem: ProblemDetails }),
]);
export type ReplyStreamEvent = z.infer<typeof ReplyStreamEvent>;

export const ChatListQuery = PageQuery.extend({
    /** Threads this agent is a member of. */
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
        summary: 'List every thread the member can see, most recently updated first',
        permission: 'chats.read',
        query: ChatListQuery,
        responses: chatPage,
    }),
    listAgentChats: defineRoute({
        id: 'listAgentChats',
        method: 'GET',
        path: '/agents/{agentId}/chats',
        summary: 'List the threads an agent is a member of, most recently updated first',
        permission: 'chats.read',
        params: AgentParams,
        query: PageQuery,
        responses: chatPage,
    }),
    createChat: defineRoute({
        id: 'createChat',
        method: 'POST',
        path: '/chats',
        summary: 'Start a thread with the User and one agent: Chatter unless the body names another',
        description: 'A repeated `requestKey` answers the thread it created and creates nothing.',
        permission: 'chats.write',
        body: { kind: 'json', schema: CreateChatBody },
        responses: { 201: oneChat },
        problems: ['agent-deleted', 'chatter-missing', 'request-key-reused'],
    }),
    getChat: defineRoute({
        id: 'getChat',
        method: 'GET',
        path: '/chats/{chatId}',
        summary: 'Get a thread',
        permission: 'chats.read',
        params: ChatParams,
        responses: { 200: oneChat },
    }),
    listChatEntries: defineRoute({
        id: 'listChatEntries',
        method: 'GET',
        path: '/chats/{chatId}/entries',
        summary: "List a thread's messages and events, newest first",
        description: 'Clients skip entry types they do not know, so engines may add types within a version.',
        permission: 'chats.read',
        params: ChatParams,
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: ChatEntryPage, read: ChatEntryPageReader } },
    }),
    sendChatMessage: defineRoute({
        id: 'sendChatMessage',
        method: 'POST',
        path: '/chats/{chatId}/messages',
        summary: 'Write in a thread as the User; agents answer with entries of their own',
        description:
            'The User joins first if it is not a member yet. A repeated `requestKey` answers the original message and saves nothing.',
        permission: 'chats.write',
        params: ChatParams,
        body: { kind: 'json', schema: SendMessageBody },
        responses: { 202: { kind: 'json', schema: SendMessageResult, read: SendMessageResultReader } },
        problems: ['request-key-reused'],
    }),
    markChatRead: defineRoute({
        id: 'markChatRead',
        method: 'POST',
        path: '/chats/{chatId}/read',
        summary: 'Mark the thread read for the calling member, so its `unread` is 0; answers nothing',
        permission: 'chats.read',
        params: ChatParams,
        responses: { 200: oneChat },
    }),
    markChatSeen: defineRoute({
        id: 'markChatSeen',
        method: 'POST',
        path: '/chats/{chatId}/seen',
        summary: 'Mark the questions in these displayed messages seen for everyone; they keep waiting for an answer',
        description: 'Idempotent. A message that asks nothing, or is not in the thread, changes nothing.',
        permission: 'chats.read',
        params: ChatParams,
        body: { kind: 'json', schema: MarkSeenBody },
        responses: { 200: oneChat },
    }),
    streamChatReply: defineRoute({
        id: 'streamChatReply',
        method: 'GET',
        path: '/chats/{chatId}/messages/{messageId}/stream',
        summary:
            "Stream a message's text as server-sent events while its author writes it; resumes after `Last-Event-ID`",
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
