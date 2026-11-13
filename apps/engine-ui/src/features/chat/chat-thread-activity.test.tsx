import { createProblem, EngineApiContractError } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { OWNER_ID } from '../../testing/agents-engine';
import { CHAT_AGENT_ID, controlReplyStreams, createChatEngine } from '../../testing/chat-engine';
import type { ChatEngine } from '../../testing/chat-engine';
import { createManualTicker } from '../../testing/manual-ticker';
import { renderWithProviders } from '../../testing/render-with-providers';
import { TEST_NOW } from '../../testing/test-engine-api';

const TIMEOUT_MS = 30_000;
const CHAT_ID = 'chat-activity';
const USER = { kind: 'user', key: 'user' } as const;
const ADA = { kind: 'agent', key: CHAT_AGENT_ID } as const;
// An hour before the engine's clock: its first change after the seed then moves `updatedAt`, which the panel follows.
const BASE_MS = TEST_NOW.getTime() - 3_600_000;
const NOW = new Date(BASE_MS).toISOString();
const later = (seconds: number) => new Date(BASE_MS + seconds * 1000).toISOString();
const HOSTILE = '<img src=x onerror="alert(1)"> [click](javascript:alert(1)) **bold**';

const history = () => screen.getByRole('region', { name: 'Messages' });

function engineWith(fields: Partial<Parameters<typeof createChatEngine>[0] & object> = {}, chat: object = {}) {
    const engine = createChatEngine({
        ...fields,
        chats: [
            {
                id: CHAT_ID,
                createdAt: NOW,
                entries: [
                    { type: 'joined', participant: USER },
                    { type: 'joined', participant: ADA },
                    { type: 'message', author: USER, createdBy: OWNER_ID, content: 'Write the spring copy', at: NOW },
                ],
                readBy: [OWNER_ID],
                ...chat,
            },
        ],
    });
    controlReplyStreams(engine);
    return engine;
}

async function renderThread(engine: ChatEngine) {
    const app = renderWithProviders({
        path: `/chats/${CHAT_ID}`,
        engineApi: engine.client,
        ticker: createManualTicker(BASE_MS),
    });
    await screen.findByRole('region', { name: 'Messages' });
    return app;
}

/** Nothing agent-written became markup: no image, no link, no bold. */
function expectInert(region: HTMLElement) {
    expect(region.querySelector('img, strong, a[href^="javascript"]')).toBeNull();
}

describe('agent steps', { timeout: TIMEOUT_MS }, () => {
    it('ticks through a working agent’s steps, then folds them above its reply', async () => {
        const engine = engineWith(
            {},
            {
                working: [
                    {
                        author: ADA,
                        startedAt: NOW,
                        steps: [
                            { kind: 'reasoning', text: '' },
                            { kind: 'tool', tool: 'Glob', text: '{specs,tasks}/**/*.md' },
                            { kind: 'tool', tool: 'Read', text: HOSTILE },
                        ],
                    },
                ],
            },
        );
        const app = await renderThread(engine);
        const card = await within(history()).findByRole('region', { name: 'Working' });
        expect(within(card).getByText('Glob')).toBeDefined();
        expect(within(card).getByText(HOSTILE, { exact: false })).toBeDefined();
        expect(within(card).getByText('0:00')).toBeDefined();
        expect(within(card).getAllByText('Done')).toHaveLength(2);
        expect(within(card).getByText('In progress')).toBeDefined();
        expect(within(card).queryAllByRole('link')).toHaveLength(0);
        expect(within(card).queryAllByRole('button')).toHaveLength(0);
        expectInert(card);
        app.ticker.advance(12_000);
        expect(within(card).getByText('0:12')).toBeDefined();
        expect(within(history()).queryByText(/is starting/)).toBeNull();
        await expectNoAxeViolations(history());

        engine.controller.finishReplyTurn(CHAT_ID, CHAT_AGENT_ID, { content: 'Here is the copy.' });
        const toggle = await within(history()).findByRole('button', { name: /Worked.* · 3 steps/ });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(within(history()).getByText('Here is the copy.')).toBeDefined();
        await app.user.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(within(history()).getByRole('list', { name: 'Steps' })).toBeDefined();
        await expectNoAxeViolations(history());
    });

    it('keeps the steps of a turn that ended without a reply open, marked unfinished', async () => {
        const engine = engineWith(
            {},
            {
                entries: [
                    { type: 'joined', participant: USER },
                    { type: 'message', author: USER, createdBy: OWNER_ID, content: 'Go', at: NOW },
                    {
                        type: 'progress',
                        author: ADA,
                        steps: [{ kind: 'tool', tool: 'Bash', text: 'ls' }],
                        at: later(4),
                    },
                    { type: 'progress', author: ADA, steps: [{ kind: 'note', text: 'Hmm' }], at: later(9) },
                    { type: 'message', author: USER, createdBy: OWNER_ID, content: 'Hello?', at: later(12) },
                ],
            },
        );
        await renderThread(engine);
        const toggle = await within(history()).findByRole('button', { name: 'Stopped without a reply · 2 steps' });
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(within(history()).getByText('Bash')).toBeDefined();
    });

    it('reads the steps an older engine flattened into text', async () => {
        const engine = engineWith(
            {},
            {
                entries: [
                    { type: 'joined', participant: USER },
                    { type: 'message', author: USER, createdBy: OWNER_ID, content: 'Go', at: NOW },
                    {
                        type: 'message',
                        author: ADA,
                        content:
                            '- thinking: \n- Glob {specs,tasks,agents}/**/*.md*\n- Read /var/lib/ptbk/projects/demo/specs/_initial.md',
                        at: later(2),
                    },
                    {
                        type: 'message',
                        author: ADA,
                        content: '- mcp__ptbk__create_task Napsat krátký text',
                        at: later(5),
                    },
                    { type: 'message', author: ADA, content: 'Copywriter is on it.', at: later(8) },
                ],
            },
        );
        await renderThread(engine);
        expect(await within(history()).findByRole('button', { name: 'Worked 6 s · 4 steps' })).toBeDefined();
        expect(within(history()).getByText('Copywriter is on it.')).toBeDefined();
        expect(within(history()).queryByText(/mcp__ptbk__create_task Napsat/)).toBeNull();
    });
});

describe('task cards', { timeout: TIMEOUT_MS }, () => {
    it('shows a linked task live, through running to completed', async () => {
        const engine = engineWith(
            {},
            {
                entries: [
                    { type: 'joined', participant: USER },
                    { type: 'joined', participant: ADA },
                    { type: 'message', author: USER, createdBy: OWNER_ID, content: 'Go', at: NOW },
                    {
                        type: 'linked',
                        task: {
                            name: 'Napsat text',
                            state: 'running',
                            agentId: CHAT_AGENT_ID,
                            detail: HOSTILE,
                            startedAt: later(1),
                        },
                        at: later(1),
                    },
                    { type: 'message', author: ADA, content: 'Started it.', at: later(2) },
                ],
            },
        );
        const app = await renderThread(engine);
        const card = await within(history()).findByRole('region', { name: 'Napsat text' });
        expect(within(card).getByText('Running')).toBeDefined();
        expect(within(card).getByText('@Ada')).toBeDefined();
        expect(within(card).getByText(HOSTILE)).toBeDefined();
        expectInert(card);
        app.ticker.advance(42_000);
        expect(within(card).getByText('0:41')).toBeDefined();
        await expectNoAxeViolations(history());

        engine.controller.updateChatTask(CHAT_ID, 'Napsat text', {
            state: 'completed',
            detail: 'Saved to copy/spring.md',
            commit: 'a1b2c3d4e5f6',
        });
        expect(await within(card).findByText('Completed')).toBeDefined();
        expect(within(card).getByText('Commit a1b2c3d')).toBeDefined();
        expect(within(card).getByText('Saved to copy/spring.md')).toBeDefined();
    });
});

describe('no response', { timeout: TIMEOUT_MS }, () => {
    it('escalates quietly from starting to an error, and Retry asks the engine without sending again', async () => {
        const engine = engineWith();
        const app = await renderThread(engine);
        expect(await within(history()).findByText('Ada is starting…')).toBeDefined();
        app.ticker.advance(19_000);
        expect(within(history()).getByText('Ada is starting…')).toBeDefined();
        app.ticker.advance(1_000);
        expect(within(history()).getByText('Still waiting for Ada')).toBeDefined();
        app.ticker.advance(100_000);
        const card = within(history()).getByRole('alert', { name: 'Ada didn’t respond' });
        await app.user.click(within(card).getByRole('button', { name: 'Details' }));
        expect(within(card).getByText(/Your message arrived at 11:00/)).toBeDefined();
        await expectNoAxeViolations(history());

        const sends = engine.spies.sendMessage.mock.calls.length;
        await app.user.click(within(card).getByRole('button', { name: 'Retry' }));
        await waitFor(() => {
            expect(engine.spies.retry).toHaveBeenCalledTimes(1);
        });
        // No recheck waited: a 409 that says the message is still queued, no error, and the wait starts over.
        const queued = await within(history()).findByText('Ada hasn’t picked this up yet. It will reply when it can.');
        expect(queued.closest('[role="status"]')).not.toBeNull();
        expect(within(history()).queryByRole('alert')).toBeNull();
        expect(screen.queryByText('That did not work. Please try again.')).toBeNull();
        expect(engine.spies.sendMessage.mock.calls.length).toBe(sends);
        await expectNoAxeViolations(history());
    });

    it('starts the wait over when the engine attempts the reply', async () => {
        const engine = engineWith();
        engine.spies.retry.mockImplementationOnce(async (chatId, signal) => {
            const chat = await engine.client.chats.get(chatId, signal);
            if (chat.kind !== 'ok') throw new Error('no chat');
            return chat;
        });
        const app = await renderThread(engine);
        app.ticker.advance(150_000);
        await app.user.click(within(history()).getByRole('button', { name: 'Retry' }));
        expect(await within(history()).findByText('Ada is starting…')).toBeDefined();
    });

    it.each([
        ['a 404', () => Promise.resolve({ kind: 'problem' as const, problem: createProblem('not-found') })],
        ['a response it cannot read', () => Promise.reject(new EngineApiContractError('retryReply', '405'))],
    ])('says Retry is not available on an engine that answers %s', async (_, answer) => {
        const engine = engineWith();
        engine.spies.retry.mockImplementationOnce(answer);
        const app = await renderThread(engine);
        app.ticker.advance(150_000);
        const card = within(history()).getByRole('alert', { name: 'Ada didn’t respond' });
        await app.user.click(within(card).getByRole('button', { name: 'Retry' }));
        const note = await within(card).findByText('Retry isn’t available on this engine.', { selector: 'p' });
        expect(note.closest('section')).toBe(card);
        const retry = within(card).getByRole('button', { name: 'Retry' });
        expect(retry.getAttribute('aria-disabled')).toBe('true');
        expect(retry.getAttribute('aria-describedby')).not.toBeNull();
        expect(screen.queryByText('That did not work. Please try again.')).toBeNull();
        await app.user.click(within(card).getByRole('button', { name: 'Retry' }));
        expect(engine.spies.retry).toHaveBeenCalledTimes(1);
        await expectNoAxeViolations(history());
    });

    it('clears the moment the agent starts working', async () => {
        const engine = engineWith();
        const app = await renderThread(engine);
        app.ticker.advance(150_000);
        expect(within(history()).getByRole('alert', { name: 'Ada didn’t respond' })).toBeDefined();
        engine.controller.startReplyTurn(CHAT_ID, CHAT_AGENT_ID);
        expect(await within(history()).findByRole('region', { name: 'Working' })).toBeDefined();
        expect(within(history()).queryByRole('alert')).toBeNull();
    });

    it('reports a Retry that fails for another reason', async () => {
        const engine = engineWith();
        engine.spies.retry.mockResolvedValueOnce({ kind: 'problem', problem: createProblem('unavailable') });
        const app = await renderThread(engine);
        app.ticker.advance(150_000);
        await app.user.click(within(history()).getByRole('button', { name: 'Retry' }));
        expect(await screen.findByText('That did not work. Please try again.')).toBeDefined();
    });

    it('offers no Retry to a member who may only read', async () => {
        const engine = engineWith({ permissions: ['agents.read', 'chats.read', 'members.read'] });
        const app = await renderThread(engine);
        app.ticker.advance(150_000);
        expect(within(history()).getByRole('alert', { name: 'Ada didn’t respond' })).toBeDefined();
        expect(within(history()).queryByRole('button', { name: 'Retry' })).toBeNull();
    });
});

describe('rechecks', { timeout: TIMEOUT_MS }, () => {
    it('shows the cause and a live countdown, and Retry now attempts the reply', async () => {
        const engine = engineWith({}, { recheck: { cause: HOSTILE, nextAt: later(100), rounds: 1, author: ADA } });
        const app = await renderThread(engine);
        const card = await within(history()).findByRole('region', { name: 'Ada couldn’t reply' });
        expect(within(card).getByText(HOSTILE)).toBeDefined();
        expectInert(card);
        expect(within(card).getByText('Retrying automatically in 1:40')).toBeDefined();
        app.ticker.advance(1_000);
        expect(within(card).getByText('Retrying automatically in 1:39')).toBeDefined();
        expect(within(history()).queryByText(/is starting/)).toBeNull();
        await expectNoAxeViolations(history());
        app.ticker.advance(99_000);
        expect(within(card).getByText('Retrying now…')).toBeDefined();

        await app.user.click(within(card).getByRole('button', { name: 'Retry now' }));
        await waitFor(() => {
            expect(engine.spies.retry).toHaveBeenCalledWith(CHAT_ID, expect.anything());
        });
        await waitFor(() => {
            expect(within(history()).queryByRole('region', { name: 'Ada couldn’t reply' })).toBeNull();
        });
    });

    it('takes a 409 as the attempt having run already', async () => {
        const engine = engineWith({}, { recheck: { cause: 'Overloaded', nextAt: later(100), rounds: 2 } });
        engine.spies.retry.mockResolvedValueOnce({ kind: 'problem', problem: createProblem('nothing-to-retry') });
        const app = await renderThread(engine);
        const card = await within(history()).findByRole('region', { name: 'Ada couldn’t reply' });
        await app.user.click(within(card).getByRole('button', { name: 'Retry now' }));
        await waitFor(() => {
            expect(engine.spies.get.mock.calls.length).toBeGreaterThan(1);
        });
        expect(screen.queryByText('That did not work. Please try again.')).toBeNull();
    });
});

describe('thread chrome', { timeout: TIMEOUT_MS }, () => {
    it('opens the day with a divider and gives each turn its time, exact on hover', async () => {
        const engine = engineWith();
        await renderThread(engine);
        expect(await within(history()).findByRole('separator', { name: 'Today' })).toBeDefined();
        const time = history().querySelector(`time[datetime="${NOW}"]`);
        expect(time?.textContent).toBe('11:00');
        expect(time?.getAttribute('title')).toMatch(/Thursday, October 1, 2026 at 11:00:00/);
    });

    it('animates only behind motion-safe, so reduced motion keeps everything still', async () => {
        const engine = engineWith(
            {},
            {
                working: [{ author: ADA, startedAt: NOW, steps: [{ kind: 'tool', tool: 'Read', text: '/a' }] }],
                entries: [
                    { type: 'joined', participant: USER },
                    { type: 'joined', participant: ADA },
                    { type: 'message', author: USER, createdBy: OWNER_ID, content: 'Go', at: NOW },
                    { type: 'linked', task: { name: 'T', state: 'running', agentId: CHAT_AGENT_ID }, at: NOW },
                ],
            },
        );
        await renderThread(engine);
        await within(history()).findByRole('region', { name: 'Working' });
        const classes = [...history().querySelectorAll('[class]')].flatMap(
            (element) => element.getAttribute('class')?.split(/\s+/) ?? [],
        );
        const moving = classes.filter((name) => /(^|:)(animate-|transition)/.test(name));
        expect(moving.length).toBeGreaterThan(0);
        expect(moving.filter((name) => !name.startsWith('motion-safe:') && name !== 'transition-colors')).toEqual([]);
    });
});
