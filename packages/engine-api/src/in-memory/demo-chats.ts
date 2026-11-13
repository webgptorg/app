import type { InMemorySeedChat } from '../in-memory-client';
import type { ReplyScript } from './kit';

const USER = { kind: 'user', key: 'user' } as const;
const CHATTER = { kind: 'agent', key: 'builtin-chatter' } as const;
const COPYWRITER = { kind: 'agent', key: 'agent-copywriter' } as const;
const MAX = { kind: 'agent', key: 'agent-max' } as const;

export const COPYWRITER_AGENT_ID = COPYWRITER.key;
/** The task Chatter created, named as Reborn names it: the title and when it was created. */
export const COPYWRITER_TASK_NAME = 'Marketingový text webu o agentech pro IT profesionály — 2026-11-13 12:16:54';
export const COPYWRITER_TASK_ID = 'task-copywriter-agents';
const COPYWRITER_COMMIT = '67b252ca';
const COPYWRITER_RESULT =
    'Napsal jsem krátký český marketingový text o agentech pro IT profesionály a uložil ho do docs/marketing-agenti-it.md.';

const CHATTER_INTRO = `Ahoj! Jsem Chatter, konverzační vstup do projektu **demo**. Mluvím za projekt a jsem váš první kontakt.

**Co umím:**
- odpovídat na otázky o projektu a jeho stavu (podívám se do souborů i do historie Gitu),
- vysvětlit, co se v projektu právě děje, a shrnout výsledky,
- z toho, na čem se domluvíme, vytvořit běžné úkoly (tasks) a sledovat je až do výsledku,
- změnit, přijmout, zrušit nebo zastavit už existující práci, když o to požádáte,
- dát vám vědět, až bude nějaká práce hotová,
- poradit se s kolegy z týmu: @Copywriter, @Developer, @Lawyer, @Planner, @Adam, @Fixer, @Router, @Tasker, @Teacher, a s @Expert, když jde o samotný Promptbook.

**Co nedělám:** v tomto chatu nic neupravuju. Větší práci předávám úkolům, které se spouští s kontrolami. Nikdy netvrdím, že je něco hotové, když je to jen navržené nebo zadané.

Stačí napsat, co potřebujete, třeba "jak jsme na tom?" nebo "chci přidat X". Česky i anglicky, jak vám vyhovuje.`;

const CHATTER_ASKS = `Ano, copywriting dělá kolega @Copywriter. Zatím ho ale nespouštím, protože nevím, co má psát. Zadání projektu (\`specs/_initial.md\`) je prázdné a v projektu nejsou žádné jiné specifikace ani úkoly, z kterých bych to poznal.

+@User Co má @Copywriter napsat? Stačí pár vět, například:
- jaký typ textu (web, e-mail, příspěvek na sociální sítě, popis produktu…),
- o čem nebo o jakém produktu je a komu je určený,
- v jakém jazyce a tónu,
- přibližná délka.

Jakmile to napíšete, vytvořím z toho úkol pro @Copywritera. Nebudu tvrdit, že se píše, dokud úkol skutečně nepoběží.`;

const CHATTER_CREATED = `Úkol pro @Copywritera jsem vytvořil. Zatím je to jen zadaný úkol, ne hotový text. Až se spustí, uvidíte jeho stav i výsledek tady v chatu.

Zadání zní takto:
- **Téma:** marketingový text webu o agentech.
- **Pro koho:** IT profesionálové.
- **Jazyk a tón:** česky, lidsky a oslovujícím tónem.
- **Rozsah:** krátký. Čekejte nadpis, podnadpis, pár krátkých bloků a výzvu k akci.
- **Obsah:** konkrétní vlastnosti agentů vezme @Copywriter z projektu a nic si nevymyslí.`;

/**
 * The demo engine's thread of 2026-11-13 (`chats/2026-11-13-1201-chatter-new-chat.book`), replayed with the times it
 * had, shifted so it ended three minutes before `now`. The User's first, unanswered message is left out.
 */
function copywriterThread(now: Date): InMemorySeedChat {
    const end = now.getTime() - 3 * 60_000;
    const endedAt = Date.parse('2026-11-13T12:17:22Z');
    const at = (time: string): string => new Date(end - (endedAt - Date.parse(`2026-11-13T${time}Z`))).toISOString();
    return {
        id: 'chat-copywriter',
        createdAt: at('12:01:52'),
        entries: [
            { type: 'joined', participant: USER },
            { type: 'joined', participant: CHATTER },
            {
                type: 'message',
                author: USER,
                createdBy: 'member-owner',
                content: 'Ahoj kdo jsi a co umis?',
                at: at('12:15:24'),
            },
            { type: 'message', author: CHATTER, content: CHATTER_INTRO, at: at('12:15:35') },
            { type: 'titled', title: 'Seznámení s Chatterem' },
            {
                type: 'message',
                author: USER,
                createdBy: 'member-owner',
                content: 'Zacni copywritovat, na to spustis kolegu co?',
                at: at('12:15:57'),
            },
            {
                type: 'progress',
                author: CHATTER,
                steps: [
                    { kind: 'reasoning', text: '' },
                    { kind: 'tool', tool: 'Glob', text: '{specs,tasks,agents}/**/*.md*' },
                    { kind: 'tool', tool: 'Read', text: '/var/lib/ptbk/projects/demo/specs/_initial.md' },
                ],
            },
            {
                type: 'message',
                author: CHATTER,
                phase: 'final',
                content: CHATTER_ASKS,
                choices: ['Web', 'E-mail', 'Příspěvek na sociální sítě', 'Popis produktu'],
                seen: true,
                at: at('12:16:05'),
            },
            { type: 'titled', title: 'Zahájení copywritingu' },
            {
                type: 'message',
                author: USER,
                createdBy: 'member-owner',
                content:
                    'marketing web pro agentech, určen pro IT profesionály, v češtině, ton aby oslovil lidi a stačí krátké',
                answers: true,
                at: at('12:16:50'),
            },
            {
                type: 'progress',
                author: CHATTER,
                steps: [
                    {
                        kind: 'tool',
                        tool: 'mcp__ptbk__create_task',
                        text: 'Napsat krátký marketingový text pro web o agentech (AI agentech v Promptbooku / projektu demo). Cílová skupina: IT profe',
                    },
                ],
            },
            {
                type: 'linked',
                at: at('12:16:54'),
                task: {
                    name: COPYWRITER_TASK_NAME,
                    state: 'completed',
                    detail: COPYWRITER_RESULT,
                    agentId: COPYWRITER.key,
                    commit: COPYWRITER_COMMIT,
                    startedAt: at('12:17:01'),
                    endedAt: at('12:17:22'),
                },
            },
            { type: 'message', author: CHATTER, phase: 'final', content: CHATTER_CREATED, at: at('12:16:58') },
            { type: 'titled', title: 'Marketingový text o agentech' },
            { type: 'joined', participant: COPYWRITER },
            {
                type: 'message',
                author: COPYWRITER,
                content: `Completed {${COPYWRITER_TASK_NAME}}: ${COPYWRITER_RESULT}\nResult commit ${COPYWRITER_COMMIT}.`,
                at: at('12:17:22'),
            },
        ],
        readBy: ['member-owner'],
    };
}

/**
 * The threads that show what agents do: the copywriter conversation, a failed reply waiting for its recheck, an agent
 * working without a word yet, and a message nobody has started answering.
 */
export function demoActivityChats(now: Date): InMemorySeedChat[] {
    const ago = (minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString();
    return [
        copywriterThread(now),
        {
            id: 'chat-recheck',
            title: 'Refund policy',
            createdAt: ago(12),
            entries: [
                { type: 'joined', participant: USER },
                { type: 'joined', participant: MAX },
                {
                    type: 'message',
                    author: USER,
                    createdBy: 'member-owner',
                    content: 'Which refunds did we approve this week?',
                },
                {
                    type: 'progress',
                    author: MAX,
                    steps: [
                        { kind: 'reasoning', text: 'The refunds are in the support mailbox; search it for this week.' },
                        { kind: 'tool', tool: 'mcp__mail__search', text: 'label:refund after:2026-11-09' },
                        { kind: 'note', level: 'error', text: 'Claude Code stopped: usage limit reached.' },
                    ],
                    at: ago(11),
                },
            ],
            recheck: {
                cause: 'Claude Code hit its usage limit; it resets in a few minutes.',
                nextAt: ago(-2),
                rounds: 1,
            },
            readBy: ['member-owner'],
        },
        {
            id: 'chat-working',
            title: 'Release notes',
            createdAt: ago(4),
            entries: [
                { type: 'joined', participant: USER },
                { type: 'joined', participant: CHATTER },
                {
                    type: 'message',
                    author: USER,
                    createdBy: 'member-owner',
                    content: 'Draft the release notes for 0.120.0.',
                },
            ],
            working: [{ author: CHATTER, startedAt: ago(4) }],
            readBy: ['member-owner'],
        },
        {
            id: 'chat-no-response',
            title: 'Invoice export',
            createdAt: ago(5),
            entries: [
                { type: 'joined', participant: USER },
                { type: 'joined', participant: CHATTER },
                {
                    type: 'message',
                    author: USER,
                    createdBy: 'member-owner',
                    content: 'Can you export last month’s invoices as CSV?',
                },
            ],
            readBy: ['member-owner'],
        },
    ];
}

const STEP_MS = 700;
const WORD_MS = 40;

/**
 * Replies as a Reborn agent writes them, for UI development: the agent thinks, looks around the project for a few
 * seconds, then streams its answer word by word.
 */
export const demoReplyScript: ReplyScript = ({ agent, content }) => ({
    steps: [
        { kind: 'reasoning', text: `What does the User need: ${content}`, delayMs: STEP_MS },
        { kind: 'tool', tool: 'Glob', text: '{specs,tasks,agents}/**/*.md*', delayMs: STEP_MS },
        { kind: 'tool', tool: 'Read', text: 'specs/_initial.md', delayMs: STEP_MS * 2 },
        { kind: 'tool', tool: 'Grep', text: 'TODO', delayMs: STEP_MS },
    ],
    chunks: `${agent.name} looked into the project. You asked: ${content}`
        .split(/(?<= )/)
        .map((text) => ({ text, delayMs: WORD_MS })),
});
