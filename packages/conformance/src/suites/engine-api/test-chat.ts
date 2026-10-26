import {
    ENGINE_API_ROUTES,
    KNOWN_CAPABILITIES,
    MAX_BOOK_SOURCE_LENGTH,
    MAX_TEST_CHAT_MESSAGES,
} from '@ptbk/engine-api';
import type { TestChatEvent, TestChatTurn } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, fail } from '../../check';
import { BROKEN_BOOK, CHAT_MESSAGE, validBook } from '../../fixtures/books';
import type { EngineApi, StreamItem } from './api';
import { describe } from './api';
import { requireCapability } from './capability-support';
import { SUITE, attempt } from './support';
import type { World } from './world';
import { REPLY_TIMEOUT_MS, createWorld } from './world';

const R = ENGINE_API_ROUTES;
const WHERE = describe(R.testAgentDraft);
const FOLLOW_UP = 'And once more, in one sentence.';

const firstTurn = (): TestChatTurn[] => [{ role: 'user', content: CHAT_MESSAGE }];

/** Everything a test run must leave alone: the saved book, its revisions and the agent's chats. */
async function storedState(owner: EngineApi, agentId: string): Promise<string> {
    const params = { agentId };
    const source = await owner.ok(R.getAgentSource, { params });
    // A fresh agent: one revision and no chat, well within a single page.
    const revisions = await owner.ok(R.listAgentRevisions, { params, query: { limit: 100 } });
    const chats = await owner.ok(R.listAgentChats, { params, query: { limit: 100 } });
    return JSON.stringify({
        source,
        revisions: revisions.items.map(({ id }) => id),
        chats: chats.items.map(({ id }) => id),
    });
}

async function testRun(world: World, agentId: string, book: string, messages: readonly TestChatTurn[]) {
    const stream = await world.owner.stream(
        R.testAgentDraft,
        { params: { agentId }, body: { book, messages } },
        { maxMs: REPLY_TIMEOUT_MS },
    );
    if (!stream.ended) fail(`${WHERE}: the reply did not end within ${String(REPLY_TIMEOUT_MS)} ms`);
    return stream.items;
}

type Delta = Extract<TestChatEvent, { type: 'delta' }>;

/**
 * Deltas count up from 1 with their `seq` as the SSE id, exactly one terminal event ends the stream, and a completed
 * reply's `content` is the deltas joined. Returns that content, or `null` when the reply did not complete.
 */
function checkReply(items: readonly StreamItem[], findings: Findings): string | null {
    const deltas = items.filter(({ event }) => event.type === 'delta');
    deltas.forEach((item, index) => {
        const { seq } = item.event as Delta;
        if (seq !== index + 1) findings.add(`${WHERE}: delta ${String(index + 1)} has seq ${String(seq)}`);
        if (item.id !== String(seq)) findings.add(`${WHERE}: delta seq ${String(seq)} has SSE id ${item.id ?? 'none'}`);
    });
    const terminals = items.filter(({ event }) => event.type !== 'delta');
    if (terminals.length !== 1) {
        findings.add(`${WHERE}: ${String(terminals.length)} terminal events instead of one`);
        return null;
    }
    const last = items.at(-1)?.event as TestChatEvent;
    if (last.type === 'delta') {
        findings.add(`${WHERE}: events follow the terminal event`);
        return null;
    }
    if (last.type === 'failed') {
        findings.add(`${WHERE}: the reply failed with ${last.problem.code}`);
        return null;
    }
    const joined = deltas.map(({ event }) => (event as Delta).text).join('');
    if (last.content !== joined) findings.add(`${WHERE}: completed content differs from the deltas joined`);
    return last.content;
}

export const TEST_CHAT_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.test-chat.draft-reply',
        suite: SUITE,
        title: 'A test run streams a reply to the unsaved book and stores nothing: no revision, chat or source change',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.testChat);
            const findings = new Findings();
            const agent = await world.createAgent('test-chat');
            const before = await storedState(world.owner, agent.id);
            const items = await testRun(world, agent.id, validBook(world.name('draft')), firstTurn());
            checkReply(items, findings);
            if ((await storedState(world.owner, agent.id)) !== before) {
                findings.add(`${WHERE}: the test run changed the saved book, its revisions or the agent's chats`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.test-chat.invalid-book',
        suite: SUITE,
        title: 'A test run of a book with an error is refused with 422 invalid-book and its diagnostics',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.testChat);
            const findings = new Findings();
            const { id: agentId } = await world.agent();
            const problem = await world.owner.problem(
                R.testAgentDraft,
                { params: { agentId }, body: { book: BROKEN_BOOK, messages: firstTurn() } },
                'invalid-book',
            );
            if (!problem.diagnostics?.some(({ severity }) => severity === 'error')) {
                findings.add(`${WHERE}: invalid-book carries no error diagnostic`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.test-chat.limits',
        suite: SUITE,
        title: 'A test run refuses an oversized book, too many messages and a transcript that does not end with the member',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.testChat);
            const findings = new Findings();
            const { id: agentId } = await world.agent();
            const book = validBook(world.name('draft'));
            const refuse = async (what: string, body: unknown, codes: readonly string[]) => {
                await attempt(findings, async () => {
                    const result = await world.owner.call(R.testAgentDraft, { params: { agentId }, body });
                    if (result.kind === 'ok') findings.add(`${WHERE}: accepted ${what} with ${String(result.status)}`);
                    else if (!codes.includes(result.problem.code)) {
                        findings.add(
                            `${WHERE}: answered ${what} with ${result.problem.code}, not ${codes.join(' or ')}`,
                        );
                    }
                });
            };
            await refuse(
                `a book over ${String(MAX_BOOK_SOURCE_LENGTH)} characters`,
                { book: `${book}${'N'.repeat(MAX_BOOK_SOURCE_LENGTH)}`, messages: firstTurn() },
                ['validation-failed', 'payload-too-large'],
            );
            await refuse(
                `more than ${String(MAX_TEST_CHAT_MESSAGES)} messages`,
                { book, messages: Array.from({ length: MAX_TEST_CHAT_MESSAGES + 1 }, () => firstTurn()[0]) },
                ['validation-failed'],
            );
            await refuse(
                "a transcript ending with the agent's message",
                { book, messages: [...firstTurn(), { role: 'agent', content: 'An earlier reply.' }] },
                ['validation-failed'],
            );
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.test-chat.audit',
        suite: SUITE,
        title: 'A test conversation is audited once when it starts, not per turn, and never with its content',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.testChat);
            const findings = new Findings();
            const { memberId } = await world.me();
            const agent = await world.createAgent('test-chat-audit');
            const book = validBook(world.name('draft'));
            const first = checkReply(await testRun(world, agent.id, book, firstTurn()), findings);
            await testRun(world, agent.id, book, [
                ...firstTurn(),
                { role: 'agent', content: first === null || first === '' ? 'An earlier reply.' : first },
                { role: 'user', content: FOLLOW_UP },
            ]);
            const page = await world.owner.ok(R.listAuditEntries, {
                query: { action: 'agent.test-chat.start', targetKind: 'agent', targetId: agent.id, limit: 100 },
            });
            const entries = page.items.filter(
                (entry) =>
                    entry.action === 'agent.test-chat.start' &&
                    entry.target?.id === agent.id &&
                    entry.outcome === 'success',
            );
            if (entries.length !== 1) {
                findings.add(`${WHERE}: ${String(entries.length)} agent.test-chat.start entries for one conversation`);
            }
            for (const entry of entries) {
                if (entry.actor.kind === 'system' || entry.actor.memberId !== memberId) {
                    findings.add(`${WHERE}: the audit entry names another member than the one who tested`);
                }
                const details = JSON.stringify(entry.details ?? null);
                if ([CHAT_MESSAGE, FOLLOW_UP, book].some((text) => details.includes(text))) {
                    findings.add(`${WHERE}: the audit entry's details carry the conversation or the book`);
                }
            }
            return findings.outcome();
        },
    },
];
