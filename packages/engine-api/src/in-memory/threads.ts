import type { Agent } from '../agents';
import type {
    Chat,
    ChatEntry,
    ChatStatus,
    ChatTask,
    Message,
    MessagePhase,
    Participant,
    ParticipantRef,
    ReplyStep,
} from '../chats';
import { MAX_WORKING_STEPS, USER_PARTICIPANT_KEY } from '../chats';
import { ChatId, MessageId } from '../common';
import type { AiToolId, MemberId, Timestamp } from '../common';
import { MAX_CHAT_PREVIEW_LENGTH } from '../constants';
import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import type { EngineContext, HandlerContext, HandlerResult, ScriptedReply } from './kit';
import type { NewTurn } from './replies';
import { advertises, fail, memberActor, ok, previewText } from './kit';
import { advanceRun, queueRun } from './runs';

/** What a member sees as the User's name; the engine has one User, whoever speaks as it. */
export const USER_NAME = 'User';
/** The engine's default partner of a new thread. */
export const CHATTER_NAME = 'Chatter';

export const USER: ParticipantRef = { kind: 'user', key: USER_PARTICIPANT_KEY };

export type ChatEvent = Exclude<ChatEntry, Message>;

export interface QuestionRecord {
    readonly id: string;
    readonly messageId: MessageId;
    readonly author: ParticipantRef;
    seenAt: Timestamp | null;
}

/** An agent's turn in a thread, from the moment it starts until its reply is saved, fails or is cancelled. */
export interface WorkingRecord {
    readonly startedAt: Timestamp;
    readonly author: ParticipantRef;
    /** The reply message once the agent writes text; `null` while it only works. */
    messageId: MessageId | null;
    /** Every step of the turn so far, oldest first; the thread shows the latest, the `progress` message keeps all. */
    readonly steps: ReplyStep[];
    /** What the turn answers, so a failed one can be attempted again. */
    readonly prompt: string;
    /** Failed attempts before this one: a retry carries the recheck's rounds. */
    readonly rounds: number;
}

/** A failed reply the engine attempts again by itself at `nextAt`, with what it needs to do so. */
export interface RecheckRecord {
    readonly cause: string;
    readonly nextAt: Timestamp;
    readonly rounds: number;
    readonly author: ParticipantRef;
    readonly prompt: string;
    /** The AI tool whose sign-in the failure needs renewed (`ai-tool-sign-in-required`), else `null`. */
    readonly aiToolId: AiToolId | null;
}

/** A thread as the in-memory engine keeps it; members see it through `chatView`. */
export interface ChatRecord {
    readonly id: ChatId;
    title: string;
    /** Until the first User message names the topic, the title is a placeholder the engine replaces. */
    placeholderTitle: boolean;
    status: ChatStatus;
    readonly members: Participant[];
    readonly createdAt: Timestamp;
    updatedAt: Timestamp;
    /** Oldest first: IDs into `state.messages` and `state.chatEvents`. */
    readonly entryIds: string[];
    messageCount: number;
    lastMessageAt: Timestamp | null;
    /** Outstanding, oldest first. */
    readonly questions: QuestionRecord[];
    /** How many entries each member had when they last marked the thread read. */
    readonly readUpTo: Map<string, number>;
    /** In the order the turns started. */
    readonly working: WorkingRecord[];
    /** In the order they were linked. */
    readonly tasks: ChatTask[];
    recheck: RecheckRecord | null;
    /** When a step change was last announced (ms), and whether a later announcement is already scheduled. */
    stepsAnnouncedAt: number | null;
    stepsAnnouncePending: boolean;
}

/** A request key's first use: what it asked for and what it created. */
export interface RequestKeyRecord {
    readonly fingerprint: string;
    readonly id: string;
}

// An active ping of the User: `+@User` or `+{User}` at the start or after whitespace or an opening bracket.
const USER_PING = /(?:^|[\s([])\+(?:@User\b|\{\s*User\s*\})/i;

export function asksUser(content: string): boolean {
    return USER_PING.test(content);
}

export function sameParticipant(a: ParticipantRef, b: ParticipantRef): boolean {
    return a.kind === b.kind && a.key === b.key;
}

export function isMember(record: ChatRecord, who: ParticipantRef): boolean {
    return record.members.some((member) => sameParticipant(member, who));
}

/** The thread's main agent: its first agent member. */
export function mainAgent(record: ChatRecord): ParticipantRef | undefined {
    const first = record.members.find((member) => member.kind === 'agent');
    return first && { kind: 'agent', key: first.key };
}

function participantName(ctx: EngineContext, who: ParticipantRef): string {
    return who.kind === 'user' ? USER_NAME : (ctx.state.agents.get(who.key)?.agent.name ?? who.key);
}

export function entriesOf(ctx: EngineContext, record: ChatRecord): ChatEntry[] {
    return record.entryIds.flatMap((id) => {
        const entry = ctx.state.messages.get(id) ?? ctx.state.chatEvents.get(id);
        return entry ? [entry] : [];
    });
}

function previewOf(ctx: EngineContext, record: ChatRecord): string | null {
    for (let index = record.entryIds.length - 1; index >= 0; index--) {
        const message = ctx.state.messages.get(record.entryIds[index] ?? '');
        const preview = message && previewText(message.content, MAX_CHAT_PREVIEW_LENGTH);
        if (preview) return preview;
    }
    return null;
}

function unreadFor(ctx: EngineContext, record: ChatRecord, memberId: MemberId): number {
    let unread = 0;
    for (const id of record.entryIds.slice(record.readUpTo.get(memberId) ?? 0)) {
        if (ctx.state.messages.get(id)?.author.kind === 'agent') unread++;
    }
    return unread;
}

/** The thread as one member sees it: `unread` is theirs, everything else is shared. */
export function chatView(ctx: EngineContext, record: ChatRecord, memberId: MemberId): Chat {
    return {
        id: record.id,
        title: record.title,
        status: record.status,
        members: record.members.map((member) => ({ ...member })),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messageCount,
        lastMessageAt: record.lastMessageAt,
        preview: previewOf(ctx, record),
        unread: unreadFor(ctx, record, memberId),
        questions: record.questions.map(({ id, messageId, author, seenAt }) => ({
            id,
            messageId,
            author,
            seen: seenAt !== null,
        })),
        working: record.working.map(({ startedAt, messageId, author, steps }) => ({
            startedAt,
            messageId,
            author,
            steps: steps.slice(-MAX_WORKING_STEPS).map((step) => ({ ...step })),
        })),
        tasks: record.tasks.map((task) => ({ ...task })),
        recheck: record.recheck && {
            cause: record.recheck.cause,
            nextAt: record.recheck.nextAt,
            rounds: record.recheck.rounds,
            aiToolId: record.recheck.aiToolId,
        },
    };
}

/** A change members should see: the thread moves up the list and listeners refetch. */
export function touch(ctx: EngineContext, record: ChatRecord, moves = true): void {
    if (moves) record.updatedAt = ctx.now();
    ctx.publish({ type: 'chat.changed', chatId: record.id });
}

export function createThread(ctx: EngineContext, input: { readonly title?: string; readonly id?: string }): ChatRecord {
    const at = ctx.now();
    const record: ChatRecord = {
        id: input.id === undefined ? ctx.newId(ChatId, 'chat') : ChatId.parse(input.id),
        title: input.title ?? '',
        placeholderTitle: input.title === undefined,
        status: 'open',
        members: [],
        createdAt: at,
        updatedAt: at,
        entryIds: [],
        messageCount: 0,
        lastMessageAt: null,
        questions: [],
        readUpTo: new Map(),
        working: [],
        tasks: [],
        recheck: null,
        stepsAnnouncedAt: null,
        stepsAnnouncePending: false,
    };
    ctx.state.chats.set(record.id, record);
    return record;
}

function appendEvent(ctx: EngineContext, record: ChatRecord, event: DistributiveOmitBase<ChatEvent>): ChatEvent {
    const id = `${record.id}~${String(record.entryIds.length + 1)}`;
    const entry: ChatEvent = { ...event, id, chatId: record.id, createdAt: ctx.now() };
    ctx.state.chatEvents.set(entry.id, entry);
    record.entryIds.push(entry.id);
    return entry;
}

type DistributiveOmitBase<T> = T extends unknown ? Omit<T, 'id' | 'chatId' | 'createdAt'> : never;

/** Adds a member once, before anything they write; a repeated join changes nothing. */
export function join(ctx: EngineContext, record: ChatRecord, who: ParticipantRef): void {
    if (isMember(record, who)) return;
    const participant: Participant = { ...who, name: participantName(ctx, who) };
    record.members.push(participant);
    appendEvent(ctx, record, { type: 'joined', participant });
}

export function retitle(ctx: EngineContext, record: ChatRecord, title: string): void {
    if (title === record.title) return;
    record.title = title;
    record.placeholderTitle = false;
    appendEvent(ctx, record, { type: 'titled', title });
}

/** A task this thread created or links came in here (`LINK {name}`); its live state is the thread's `tasks`. */
export function link(ctx: EngineContext, record: ChatRecord, task: ChatTask): void {
    record.tasks.push(task);
    appendEvent(ctx, record, { type: 'linked', task: task.name });
}

export function setStatus(ctx: EngineContext, record: ChatRecord, status: ChatStatus): void {
    if (status === record.status) return;
    record.status = status;
    appendEvent(ctx, record, { type: 'status', status });
}

export interface NewMessage {
    readonly author: ParticipantRef;
    readonly content: string;
    readonly status: Message['status'];
    readonly createdBy?: MemberId | null;
    readonly choices?: readonly string[];
    readonly phase?: MessagePhase | null;
    readonly steps?: readonly ReplyStep[];
}

/** The author joins first if they are not a member; IDs follow the engine's `<chat>#<position>`. */
export function appendMessage(ctx: EngineContext, record: ChatRecord, input: NewMessage): Message {
    join(ctx, record, input.author);
    const message: Message = {
        type: 'message',
        id: MessageId.parse(`${record.id}#${String(record.messageCount + 1)}`),
        chatId: record.id,
        author: input.author,
        content: input.content,
        status: input.status,
        createdBy: input.createdBy ?? null,
        createdAt: ctx.now(),
        choices: [...(input.choices ?? [])],
        phase: input.phase ?? null,
        steps: (input.steps ?? []).map((step) => ({ ...step })),
    };
    ctx.state.messages.set(message.id, message);
    record.entryIds.push(message.id);
    record.messageCount++;
    record.lastMessageAt = message.createdAt;
    if (message.status === 'completed') settleMessage(ctx, record, message);
    return message;
}

/**
 * A message's text is final: an agent's active `+@User` becomes an outstanding question, so the thread waits for the
 * User. Replaying or re-reading history never pings again: this runs once per message.
 */
export function settleMessage(ctx: EngineContext, record: ChatRecord, message: Message): void {
    if (message.author.kind !== 'agent' || message.status !== 'completed' || !asksUser(message.content)) return;
    if (record.questions.some((question) => question.messageId === message.id)) return;
    join(ctx, record, USER);
    record.questions.push({ id: `ping:${message.id}`, messageId: message.id, author: message.author, seenAt: null });
    setStatus(ctx, record, 'waiting-for-user');
}

/** A saved answer clears its question at once; the thread stops waiting once none is left. */
export function answer(ctx: EngineContext, record: ChatRecord, question: QuestionRecord): void {
    record.questions.splice(record.questions.indexOf(question), 1);
    if (record.questions.length === 0 && record.status === 'waiting-for-user') setStatus(ctx, record, 'open');
}

/** Marks the questions of displayed messages seen; `true` when one was not seen before. */
export function markSeen(ctx: EngineContext, record: ChatRecord, messageIds: readonly string[]): boolean {
    let changed = false;
    for (const question of record.questions) {
        if (question.seenAt === null && messageIds.includes(question.messageId)) {
            question.seenAt = ctx.now();
            changed = true;
        }
    }
    return changed;
}

/** The question a User message answers: the one it names, else the only one waiting. */
export function answeredQuestion(record: ChatRecord, replyTo: string | undefined): QuestionRecord | undefined {
    if (replyTo !== undefined) return record.questions.find((question) => question.messageId === replyTo);
    return record.questions.length === 1 ? record.questions[0] : undefined;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The agent a User message brings in, as Chatter would: an active `+@Name` / `+{Full Name}`, or plain words ("ask
 * Ada", "bring in Ada", "invite Ada"). Passive `@Name` invites nobody. The earliest mention wins.
 */
export function invitedAgent(ctx: EngineContext, content: string): ParticipantRef | undefined {
    let best: { readonly at: number; readonly key: string } | undefined;
    for (const { agent } of ctx.state.agents.values()) {
        if (agent.deletedAt !== null) continue;
        const name = escapeRegExp(agent.name);
        const compact = escapeRegExp(agent.name.replace(/\s+/g, ''));
        const pattern = new RegExp(
            `(?:^|[\\s([])\\+(?:@${compact}(?![\\w-])|\\{\\s*${name}\\s*\\})|\\b(?:ask|bring in|invite)\\s+${name}\\b`,
            'i',
        );
        const match = pattern.exec(content);
        if (match && (best === undefined || match.index < best.at)) best = { at: match.index, key: agent.id };
    }
    return best && { kind: 'agent', key: best.key };
}

const ASK_ME = /\bask me\b/i;
const QUESTION_TEXT = '\n\n+@User Shall I go ahead with this?';
const QUESTION_CHOICES = ['Yes, go ahead', 'Not yet'] as const;

/** The first words of the User's first message: the engine retitles a thread as its topic becomes clear. */
function titleFrom(content: string): string | null {
    const words = content.replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ');
    return previewText(words, 80);
}

/**
 * Who answers a User message, as the engine routes it: the author of the question it answers; else an agent the
 * message brings in (the main agent says so first, then the agent joins and answers); else the main agent. Returns
 * the turn for the caller to start, or nothing when no live agent answers.
 */
export function respond(
    ctx: HandlerContext,
    record: ChatRecord,
    message: Message,
    answered: QuestionRecord | undefined,
): NewTurn | undefined {
    const messageIndex = record.messageCount - 1;
    if (record.placeholderTitle && message.author.kind === 'user') {
        const title = titleFrom(message.content);
        if (title) retitle(ctx, record, title);
    }
    const main = mainAgent(record);
    let responder = answered?.author ?? main;
    const invited = answered ? undefined : invitedAgent(ctx, message.content);
    if (invited && main && !sameParticipant(invited, main)) {
        if (!isMember(record, invited)) {
            const name = participantName(ctx, invited);
            appendMessage(ctx, record, {
                author: main,
                content: `I'll bring in ${name} for this.`,
                status: 'completed',
            });
        }
        responder = invited;
    }
    const agent = responder?.kind === 'agent' ? ctx.state.agents.get(responder.key)?.agent : undefined;
    if (!responder || !agent || agent.deletedAt !== null) return undefined;
    const script = ctx.replyScript({
        agent,
        content: message.content,
        chatId: record.id,
        messageIndex,
    });
    const asks = ASK_ME.test(message.content);
    return {
        author: responder,
        script: asks ? withQuestion(script) : script,
        prompt: message.content,
        ...(asks ? { choices: QUESTION_CHOICES } : {}),
        onReply: (reply) => {
            trackRun(ctx, record, agent, reply, message.content);
        },
    };
}

/** With `runs@1`, every reply is a run of its agent, from the moment the agent writes it. */
export function trackRun(ctx: HandlerContext, record: ChatRecord, agent: Agent, reply: Message, prompt: string): void {
    if (!advertises(ctx, KNOWN_CAPABILITIES.runs)) return;
    const run = queueRun(ctx, {
        agentId: agent.id,
        source: 'web',
        chatId: record.id,
        messageId: reply.id,
        createdBy: ctx.member.id,
        actor: memberActor(ctx),
        preview: prompt,
    });
    advanceRun(ctx, run.id);
}

function withQuestion(script: ScriptedReply): ScriptedReply {
    return { ...script, chunks: [...script.chunks, QUESTION_TEXT] };
}

export type KeyedRequest =
    | { readonly kind: 'new'; remember(id: string): void }
    | { readonly kind: 'repeat'; readonly id: string }
    | { readonly kind: 'reused' };

/**
 * A request key, per member and scope: a repeat of the same request answers what the first one created; the same key
 * for a different request is refused. Without a key every request is new.
 */
export function requestKeyOf(
    ctx: HandlerContext,
    scope: string,
    requestKey: string | undefined,
    request: Readonly<Record<string, unknown>>,
): KeyedRequest {
    if (requestKey === undefined) return { kind: 'new', remember: () => undefined };
    const key = `${ctx.member.id} ${scope} ${requestKey}`;
    const fingerprint = JSON.stringify(request);
    const earlier = ctx.state.chatRequestKeys.get(key);
    if (earlier) return earlier.fingerprint === fingerprint ? { kind: 'repeat', id: earlier.id } : { kind: 'reused' };
    return { kind: 'new', remember: (id) => ctx.state.chatRequestKeys.set(key, { fingerprint, id }) };
}

/**
 * The default partner of a new thread: the engine's core Chatter (`builtInAgents`), never a project agent that happens
 * to share the name, and never silently another agent.
 */
export function chatter(ctx: EngineContext): HandlerResult<Agent> {
    const key = CHATTER_NAME.toLowerCase();
    for (const { agent } of ctx.state.agents.values()) {
        if (agent.deletedAt === null && agent.origin === 'core' && agent.name.toLowerCase() === key) return ok(agent);
    }
    return fail('chatter-missing', { detail: 'The engine has no Chatter to start a thread with.' });
}
