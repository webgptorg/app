import { ChatId, MemberId, MessageId } from '@ptbk/engine-api';
import type { ReadChat, ReadChatEntry, ReadMessage } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { INITIAL_CHAT_SESSION } from './chat-session';
import type { ChatSessionState } from './chat-session';
import { addressedAgent, calendarDay, participantName, threadViews } from './message-views';
import type { StepsView, ThreadView } from './message-views';

const me = MemberId.parse('member-owner');
const chatId = ChatId.parse('Thread — 2026-10-01 12:00:00');
const at = '2026-10-01T12:00:00Z' as ReadMessage['createdAt'];
const ADA = { kind: 'agent', key: 'agent-ada' } as const;
const USER = { kind: 'user', key: 'user' } as const;

function message(position: number, fields: Partial<ReadMessage> = {}): ReadMessage {
    return {
        type: 'message',
        id: MessageId.parse(`${chatId}#${String(position)}`),
        chatId,
        author: ADA,
        content: `Text ${String(position)}`,
        status: 'completed',
        createdBy: null,
        createdAt: at,
        choices: [],
        phase: null,
        steps: [],
        ...fields,
    };
}

type ViewChat = Pick<ReadChat, 'members' | 'questions' | 'working' | 'tasks' | 'recheck'>;
const chat: ViewChat = {
    members: [
        { kind: 'user', key: 'user', name: 'User' },
        { kind: 'agent', key: 'agent-ada', name: 'Ada' },
    ],
    questions: [],
    working: [],
    tasks: [],
    recheck: null,
};
const session = (fields: Partial<ChatSessionState>): ChatSessionState => ({ ...INITIAL_CHAT_SESSION, ...fields });
const options = { memberId: me, canSendAgain: true, timeZone: 'UTC' };
/** The views without day dividers, which have tests of their own. */
const rows = (...args: Parameters<typeof threadViews>) => threadViews(...args).filter((view) => view.kind !== 'day');

describe('threadViews', () => {
    it('names authors, shows agents joining and new titles, and hides the User joining', () => {
        const entries: ReadChatEntry[] = [
            { type: 'joined', id: 'j1', chatId, createdAt: at, participant: { ...USER, name: 'User' } },
            { type: 'joined', id: 'j2', chatId, createdAt: at, participant: { ...ADA, name: 'Ada' } },
            message(1, { author: USER, createdBy: me }),
            { type: 'titled', id: 't1', chatId, createdAt: at, title: 'Billing' },
            { type: 'status', id: 's1', chatId, createdAt: at, status: 'open' },
            { type: 'status', id: 's2', chatId, createdAt: at, status: 'resolved' },
            message(2),
        ];
        const views = rows(chat, entries, INITIAL_CHAT_SESSION, options);
        expect(
            views.map((view) =>
                view.kind === 'event'
                    ? view.text
                    : view.kind === 'message'
                      ? `${view.authorName}|${view.text}`
                      : view.kind,
            ),
        ).toEqual(['Ada joined', '|Text 1', 'Renamed to “Billing”', 'Marked as resolved', 'Ada|Text 2']);
    });

    it('labels stored states and lays the followed reply’s live text over its row', () => {
        const views = rows(
            chat,
            [
                message(1, { status: 'cancelled', content: '' }),
                message(2, { status: 'failed' }),
                message(3, { status: 'streaming', content: '' }),
            ],
            session({
                phase: 'interrupted',
                reply: { messageId: message(3).id, text: 'partial', lastSeq: 2 },
                partials: new Map([[message(1).id, 'kept']]),
            }),
            options,
        );
        expect(
            views.map((view) => (view.kind === 'message' ? [view.state, view.text, view.retry, view.markdown] : null)),
        ).toEqual([
            ['stopped', 'kept', false, false],
            ['failed', 'Text 2', false, false],
            ['interrupted', 'partial', true, false],
        ]);
        const done = rows(chat, [message(4), message(5, { author: USER })], INITIAL_CHAT_SESSION, options);
        expect(done.flatMap((view) => (view.kind === 'message' ? [view.markdown] : []))).toEqual([true, false]);
        const later = rows(chat, [message(6, { status: 'unknown' })], INITIAL_CHAT_SESSION, options);
        expect(later.map((view) => (view.kind === 'message' ? [view.state, view.text, view.markdown] : null))).toEqual([
            [null, 'Text 6', false],
        ]);
    });

    it('marks outstanding questions with their choices, and shows the message being sent', () => {
        const question = message(1, { choices: ['Yes', 'No'] });
        const views = rows(
            { ...chat, questions: [{ id: 'q', messageId: question.id, author: ADA, seen: false }] },
            [question, message(2, { choices: ['Ignored'] })],
            session({ phase: 'unconfirmed', outgoing: 'Yes' }),
            options,
        );
        expect(
            views.map((view) => (view.kind === 'message' ? [view.question, view.choices, view.state] : null)),
        ).toEqual([
            [{ seen: false }, ['Yes', 'No'], null],
            [null, [], null],
            [null, [], 'unconfirmed'],
        ]);
    });

    it('falls back to the key for a participant the thread does not list', () => {
        expect(participantName(chat, { kind: 'agent', key: 'agent-gone' })).toBe('agent-gone');
    });

    it('names the agent a message addresses, else the thread’s main agent', () => {
        const members = [
            ...chat.members,
            { kind: 'agent', key: 'agent-copy', name: 'Copywriter' },
            { kind: 'agent', key: 'agent-copy-cz', name: 'Copywriter CZ' },
        ] as const;
        expect(addressedAgent(members, '+@Copywriter write it')?.key).toBe('agent-copy');
        expect(addressedAgent(members, '@Copywriter CZ, napiš to')?.key).toBe('agent-copy-cz');
        expect(addressedAgent(members, '+@Copywriters are great')?.key).toBe('agent-ada');
        expect(addressedAgent(members, '@Nobody hi')?.key).toBe('agent-ada');
        expect(addressedAgent(members, 'Hi @Copywriter')?.key).toBe('agent-ada');
        expect(addressedAgent([{ kind: 'user', key: 'user', name: 'User' }], 'Hi')).toBeUndefined();
    });
});

const CHATTER = { kind: 'agent', key: 'builtin-chatter' } as const;
const COPY = { kind: 'agent', key: 'agent-copy' } as const;
const team: ViewChat = {
    ...chat,
    members: [...chat.members, { ...CHATTER, name: 'Chatter' }, { ...COPY, name: 'Copywriter' }],
};
const minute = (minutes: number, seconds = 0) =>
    new Date(Date.UTC(2026, 10, 13, 12, minutes, seconds)).toISOString() as ReadMessage['createdAt'];
const read = (name: string, text: string) => ({ kind: 'tool', tool: name, text, level: 'info' }) as const;
const think = (text: string) => ({ kind: 'reasoning', tool: null, text, level: 'info' }) as const;

const shape = (views: readonly ThreadView[]) =>
    views.map((view) => {
        switch (view.kind) {
            case 'message':
                return `message ${view.authorName || 'User'}: ${view.text}`;
            case 'steps':
                return `steps ${view.authorName} ${view.status} ${String(view.steps.length)}`;
            case 'task':
                return `task ${view.name} ${view.task?.state ?? '?'}`;
            case 'event':
                return `event ${view.text}`;
            case 'day':
                return `day ${view.at.slice(0, 10)}`;
            case 'waiting':
                return `waiting ${view.agentName}`;
            case 'recheck':
                return `recheck ${view.agentName ?? '?'}`;
        }
    });
const stepsOf = (views: readonly ThreadView[]) => views.filter((view): view is StepsView => view.kind === 'steps');

describe('threadViews turns', () => {
    it('folds an agent’s progress into one turn above the reply that ends it', () => {
        const views = rows(
            team,
            [
                message(1, { author: USER, createdBy: me, createdAt: minute(16) }),
                message(2, { author: CHATTER, phase: 'progress', steps: [think('Who?')], createdAt: minute(16, 2) }),
                message(3, {
                    author: CHATTER,
                    phase: 'progress',
                    steps: [read('Glob', '*.md'), read('Read', '/a.md')],
                    createdAt: minute(16, 6),
                }),
                message(4, { author: CHATTER, phase: 'final', content: 'Done', createdAt: minute(16, 10) }),
            ],
            INITIAL_CHAT_SESSION,
            options,
        );
        expect(shape(views)).toEqual(['message User: Text 1', 'steps Chatter done 3', 'message Chatter: Done']);
        const [turn] = stepsOf(views);
        expect([turn?.id, turn?.startedAt, turn?.endedAt]).toEqual([
            `steps:${message(2).id}`,
            minute(16, 2),
            minute(16, 10),
        ]);
    });

    it('keeps progress without a reply as unfinished where it happened, and live while the agent works', () => {
        const entries = [
            message(1, { author: USER, createdBy: me, createdAt: minute(1) }),
            message(2, { author: CHATTER, phase: 'progress', steps: [think('a')], createdAt: minute(2) }),
            message(3, { author: ADA, content: 'Meanwhile', createdAt: minute(3) }),
        ];
        expect(shape(rows(team, entries, INITIAL_CHAT_SESSION, options))).toEqual([
            'message User: Text 1',
            'steps Chatter unfinished 1',
            'message Ada: Meanwhile',
        ]);
        const working = {
            author: CHATTER,
            startedAt: minute(1, 30),
            messageId: null,
            steps: [think('a'), read('Read', '/b')],
        };
        const busy = rows({ ...team, working: [working] }, entries, INITIAL_CHAT_SESSION, options);
        expect(shape(busy)).toEqual(['message User: Text 1', 'message Ada: Meanwhile', 'steps Chatter live 2']);
        // The same card from live to folded, so it collapses rather than being replaced.
        expect(stepsOf(busy)[0]?.id).toBe(`steps:${message(2).id}`);
        expect(stepsOf(busy)[0]?.startedAt).toBe(minute(1, 30));
    });

    it('attaches the live card to the reply it streams, and shows one for an agent that has no steps yet', () => {
        const streaming = message(2, { author: CHATTER, phase: 'final', status: 'streaming', content: '' });
        const views = rows(
            {
                ...team,
                working: [
                    { author: CHATTER, startedAt: minute(1), messageId: streaming.id, steps: [] },
                    { author: COPY, startedAt: minute(2), messageId: null, steps: [] },
                ],
            },
            [message(1, { author: USER, createdBy: me }), streaming],
            INITIAL_CHAT_SESSION,
            options,
        );
        expect(shape(views)).toEqual([
            'message User: Text 1',
            'steps Chatter live 0',
            'message Chatter: ',
            'steps Copywriter live 0',
        ]);
        expect(stepsOf(views).map((view) => view.id)).toEqual([
            'working:agent:builtin-chatter',
            'working:agent:agent-copy',
        ]);
    });

    it('reads an old engine’s flattened steps, and only those followed by the same agent', () => {
        const flattened = '- thinking: \n- Glob {specs,tasks,agents}/**/*.md*\n- Read /var/lib/ptbk/specs/_initial.md';
        const views = rows(
            team,
            [
                message(1, { author: USER, createdBy: me }),
                message(2, { author: CHATTER, content: flattened }),
                message(3, { author: CHATTER, content: '- mcp__ptbk__create_task Napsat krátký text' }),
                message(4, { author: CHATTER, content: 'Copywriter is on it.' }),
                message(5, { author: ADA, content: '- Apples\n- Pears' }),
                message(6, { author: ADA, content: 'Anything else?' }),
                message(7, { author: COPY, content: flattened }),
            ],
            INITIAL_CHAT_SESSION,
            options,
        );
        expect(shape(views)).toEqual([
            'message User: Text 1',
            'steps Chatter done 4',
            'message Chatter: Copywriter is on it.',
            'message Ada: - Apples\n- Pears',
            'message Ada: Anything else?',
            `message Copywriter: ${flattened}`,
        ]);
    });

    it('reads a progress message without steps from its text', () => {
        const views = rows(
            team,
            [
                message(1, { author: CHATTER, phase: 'progress', content: '- Read /a.md' }),
                message(2, { author: CHATTER, phase: 'progress', content: 'Looking around' }),
                message(3, { author: CHATTER, phase: 'progress', content: ' ' }),
                message(4, { author: CHATTER, phase: 'final', content: 'Done' }),
            ],
            INITIAL_CHAT_SESSION,
            options,
        );
        expect(stepsOf(views)[0]?.steps).toEqual([
            read('Read', '/a.md'),
            { kind: 'note', tool: null, text: 'Looking around', level: 'info' },
        ]);
    });

    it('turns linked entries into task cards with the thread’s live state', () => {
        const linked = { type: 'linked', id: 'l1', chatId, createdAt: at, task: 'Napsat text' } as const;
        const task = {
            name: 'Napsat text',
            taskId: null,
            detail: 'Drafting',
            agentId: 'agent-copy',
            commit: null,
            reopened: false,
            startedAt: at,
            endedAt: null,
            state: 'running',
        } as ViewChat['tasks'][number];
        const views = rows(
            { ...team, tasks: [task] },
            [linked, { ...linked, id: 'l2', task: 'Gone' }],
            INITIAL_CHAT_SESSION,
            options,
        );
        expect(shape(views)).toEqual(['task Napsat text running', 'task Gone ?']);
        expect(views[0]?.kind === 'task' && views[0].agent?.name).toBe('Copywriter');
        expect(views[1]?.kind === 'task' && views[1].agent).toBeNull();
    });
});

describe('threadViews waiting and rechecks', () => {
    const asked = message(1, { author: USER, createdBy: me, content: '+@Copywriter write it', createdAt: minute(5) });

    it('waits on the addressed agent until someone answers or works', () => {
        expect(shape(rows(team, [asked], INITIAL_CHAT_SESSION, options))).toEqual([
            'message User: +@Copywriter write it',
            'waiting Copywriter',
        ]);
        const waiting = rows(team, [asked], INITIAL_CHAT_SESSION, options).at(-1);
        expect(waiting?.kind === 'waiting' && waiting.since).toBe(minute(5));
        const working = { author: COPY, startedAt: minute(6), messageId: null, steps: [] };
        expect(shape(rows({ ...team, working: [working] }, [asked], INITIAL_CHAT_SESSION, options))).toEqual([
            'message User: +@Copywriter write it',
            'steps Copywriter live 0',
        ]);
        const answered = [asked, message(2, { author: COPY, status: 'streaming', content: '' })];
        expect(shape(rows(team, answered, INITIAL_CHAT_SESSION, options)).at(-1)).toBe('message Copywriter: ');
        expect(shape(rows(team, [asked], session({ phase: 'sending', outgoing: 'Again' }), options)).at(-1)).toBe(
            'message User: Again',
        );
        expect(shape(rows(team, [{ ...asked, status: 'failed' }], INITIAL_CHAT_SESSION, options))).toHaveLength(1);
        expect(shape(rows({ ...team, members: [] }, [asked], INITIAL_CHAT_SESSION, options))).toHaveLength(1);
    });

    it('shows a recheck instead, naming the waiting agent or the thread’s main one', () => {
        const recheck = { cause: 'Model overloaded', nextAt: minute(9), rounds: 2, aiToolId: null };
        const views = rows({ ...team, recheck }, [asked], INITIAL_CHAT_SESSION, options);
        expect(views.at(-1)).toEqual({
            kind: 'recheck',
            id: 'recheck',
            agent: COPY,
            agentName: 'Copywriter',
            cause: 'Model overloaded',
            nextAt: minute(9),
            rounds: 2,
            aiToolId: null,
        });
        const quiet = rows({ ...team, recheck }, [message(2)], INITIAL_CHAT_SESSION, options).at(-1);
        expect(quiet?.kind === 'recheck' && quiet.agentName).toBe('Ada');
        const nobody = rows({ ...team, members: [], recheck }, [], INITIAL_CHAT_SESSION, options).at(-1);
        expect(nobody?.kind === 'recheck' && nobody.agent).toBeNull();
    });
});

describe('threadViews days', () => {
    it('opens each calendar day of the reader’s zone with a divider', () => {
        const views = threadViews(
            chat,
            [
                message(1, { createdAt: '2026-11-12T22:30:00Z' as ReadMessage['createdAt'] }),
                message(2, { createdAt: '2026-11-12T23:30:00Z' as ReadMessage['createdAt'] }),
                message(3, { createdAt: '2026-11-13T08:00:00Z' as ReadMessage['createdAt'] }),
            ],
            session({ phase: 'sending', outgoing: 'Hi' }),
            { ...options, timeZone: 'Europe/Prague' },
        );
        expect(shape(views)).toEqual([
            'day 2026-11-12',
            'message Ada: Text 1',
            'day 2026-11-12',
            'message Ada: Text 2',
            'message Ada: Text 3',
            'message User: Hi',
        ]);
        expect(calendarDay('2026-11-12T23:30:00Z', 'Europe/Prague')).toBe('2026-11-13');
        expect(calendarDay('2026-11-12T23:30:00Z', 'UTC')).toBe('2026-11-12');
    });
});
