import type {
    EngineApiClient,
    EngineApiStreamItem,
    Message,
    Permission,
    ReplyStreamEvent,
    TestChatEvent,
} from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import type {
    InMemoryEngineController,
    InMemorySeedChat,
    InMemorySeedEntry,
    ReplyScript,
} from '@ptbk/engine-api/in-memory';
import { vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { OWNER_ID, SECOND_MEMBER_ID, SECOND_MEMBER_NAME } from './agents-engine';
import { TEST_NOW } from './test-engine-api';

export const CHAT_AGENT_ID = 'agent-ada';
export const CHAT_AGENT_NAME = 'Ada';

export const CHATTER_ID = 'builtin-chatter';

const at = (minutesAgo: number, offsetMs = 0) =>
    new Date(TEST_NOW.getTime() - minutesAgo * 60_000 + offsetMs).toISOString();

const USER = { kind: 'user', key: 'user' } as const;
const ADA = { kind: 'agent', key: CHAT_AGENT_ID } as const;

/**
 * A thread of the User and Ada with `count` messages alternating User and Ada, oldest first, the User's written by
 * `createdBy`. Message IDs follow the engine's `<chat>#<position>`.
 */
export function seededConversation(chatId: string, count: number, createdBy: string): InMemorySeedChat {
    return {
        id: chatId,
        createdAt: at(count + 1),
        entries: [
            { type: 'joined', participant: USER },
            { type: 'joined', participant: ADA },
            ...Array.from({ length: count }, (_, index): InMemorySeedEntry => {
                // A second apart, so the order by time is the order written.
                const when = at(count, index * 1000);
                return index % 2 === 0
                    ? { type: 'message', author: USER, createdBy, content: `Question ${String(index + 1)}`, at: when }
                    : { type: 'message', author: ADA, content: `Answer ${String(index + 1)}`, at: when };
            }),
        ],
        readBy: [OWNER_ID, SECOND_MEMBER_ID],
    };
}

export interface ChatEngineOptions {
    readonly chats?: readonly InMemorySeedChat[];
    readonly permissions?: readonly Permission[];
    readonly replyScript?: ReplyScript;
    /** Ada's book, for a profile the default one lacks (e.g. `INITIAL MESSAGE`); its first line must stay "Ada". */
    readonly agentSource?: string;
}

type ChatMethods = EngineApiClient['chats'];

export interface ChatEngine {
    /** Pass as `engineApi`; chat methods are spies, so tests count, inspect and override calls. */
    readonly client: EngineApiClient;
    readonly controller: InMemoryEngineController;
    readonly spies: { readonly [Key in keyof ChatMethods]: MockInstance<ChatMethods[Key]> };
    /** The engine's own chat methods, for an override that lets the call through and then fails. */
    readonly real: ChatMethods;
}

/** The in-memory engine with one agent ("Ada"), the owner, a second member, and the given chats. */
export function createChatEngine(options: ChatEngineOptions = {}): ChatEngine {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: {
            engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            members: [
                {
                    id: SECOND_MEMBER_ID,
                    displayName: SECOND_MEMBER_NAME,
                    role: 'admin',
                    status: 'active',
                    createdAt: '2026-09-01T00:00:00.000Z',
                    lastSeenAt: null,
                },
            ],
            agents: [
                {
                    id: CHATTER_ID,
                    source: 'Chatter\nPERSONA Talks with you and brings in the right agent',
                    origin: 'core',
                },
                {
                    id: CHAT_AGENT_ID,
                    source: options.agentSource ?? `${CHAT_AGENT_NAME}\nPERSONA Research`,
                    visibility: 'public',
                },
            ],
            chats: options.chats ?? [],
        },
        ...(options.permissions === undefined
            ? {}
            : { member: { id: OWNER_ID, permissions: options.permissions, role: 'member' } }),
        ...(options.replyScript === undefined ? {} : { replyScript: options.replyScript }),
    });
    const real = { ...engine.client.chats };
    const chats = { ...real };
    const spies = {
        listAll: vi.spyOn(chats, 'listAll'),
        list: vi.spyOn(chats, 'list'),
        create: vi.spyOn(chats, 'create'),
        get: vi.spyOn(chats, 'get'),
        listEntries: vi.spyOn(chats, 'listEntries'),
        sendMessage: vi.spyOn(chats, 'sendMessage'),
        markRead: vi.spyOn(chats, 'markRead'),
        markSeen: vi.spyOn(chats, 'markSeen'),
        streamReply: vi.spyOn(chats, 'streamReply'),
        cancelReply: vi.spyOn(chats, 'cancelReply'),
        retry: vi.spyOn(chats, 'retry'),
    };
    return { client: { ...engine.client, chats }, controller: engine.controller, spies, real };
}

/** Both reply streams number their deltas with `seq`, which is also the SSE id. */
type StreamEvent = ReplyStreamEvent | TestChatEvent;

/**
 * A reply stream the test drives by hand: each `push` delivers one event, `end` closes it without a final event (a
 * dropped connection), and the consumer's abort ends it too, as the fetch client's stream would.
 */
export interface ControlledStream<Event extends StreamEvent = ReplyStreamEvent> {
    readonly iterable: AsyncIterable<EngineApiStreamItem<Event>>;
    push(event: Event): void;
    end(): void;
    readonly aborted: () => boolean;
}

export function createControlledStream<Event extends StreamEvent = ReplyStreamEvent>(
    signal: AbortSignal,
): ControlledStream<Event> {
    const queue: (EngineApiStreamItem<Event> | null)[] = [];
    let wake: (() => void) | undefined;
    const notify = () => {
        wake?.();
        wake = undefined;
    };
    signal.addEventListener('abort', notify, { once: true });
    const iterable: AsyncIterable<EngineApiStreamItem<Event>> = {
        async *[Symbol.asyncIterator]() {
            for (;;) {
                if (signal.aborted) return;
                const next = queue.shift();
                if (next === null) return;
                if (next !== undefined) {
                    yield next;
                    continue;
                }
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            }
        },
    };
    return {
        iterable,
        push(event) {
            queue.push({ id: event.type === 'delta' ? String(event.seq) : null, event });
            notify();
        },
        end() {
            queue.push(null);
            notify();
        },
        aborted: () => signal.aborted,
    };
}

/**
 * Replaces the engine's reply streams with controlled ones; `streams` lists them in the order the panel opened them,
 * with the options it passed (`lastEventId` on a resume).
 */
export function controlReplyStreams(engine: ChatEngine) {
    const streams: { readonly stream: ControlledStream; readonly lastEventId: string | undefined }[] = [];
    engine.spies.streamReply.mockImplementation((_chatId, _messageId, options, signal) => {
        const stream = createControlledStream(signal);
        streams.push({ stream, lastEventId: options.lastEventId });
        return Promise.resolve({ kind: 'ok', data: stream.iterable });
    });
    return {
        streams,
        latest(): ControlledStream {
            const latest = streams.at(-1);
            if (latest === undefined) throw new Error('no reply stream was opened');
            return latest.stream;
        },
    };
}

/** The completed reply the engine would send at the end of a stream. */
export function completedReply(base: Pick<Message, 'id' | 'chatId' | 'createdAt'>, content: string): Message {
    return {
        ...base,
        type: 'message',
        author: ADA,
        content,
        status: 'completed',
        createdBy: null,
        choices: [],
        phase: null,
        steps: [],
    };
}
