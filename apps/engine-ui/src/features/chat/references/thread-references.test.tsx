import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../../testing/axe';
import { OWNER_ID } from '../../../testing/agents-engine';
import { CHAT_AGENT_ID, createChatEngine } from '../../../testing/chat-engine';
import { renderWithProviders } from '../../../testing/render-with-providers';
import { TEST_NOW } from '../../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const CHAT_ID = 'chat-references';
const TASK = 'Write the launch post';
const USER = { kind: 'user', key: 'user' } as const;
const ADA = { kind: 'agent', key: CHAT_AGENT_ID } as const;
const at = (minutesAgo: number) => new Date(TEST_NOW.getTime() - minutesAgo * 60_000).toISOString();

function referencesEngine(working = false) {
    return createChatEngine({
        chats: [
            {
                id: CHAT_ID,
                createdAt: at(10),
                entries: [
                    { type: 'joined', participant: USER },
                    { type: 'joined', participant: ADA },
                    { type: 'message', author: USER, createdBy: OWNER_ID, content: 'Write it', at: at(9) },
                    {
                        type: 'linked',
                        at: at(8),
                        task: {
                            name: TASK,
                            taskId: 'task-launch',
                            state: 'completed',
                            detail: 'Saved to docs/launch.md',
                            agentId: CHAT_AGENT_ID,
                            commit: '67b252ca91',
                            startedAt: at(8),
                            endedAt: new Date(Date.parse(at(8)) + 21_000).toISOString(),
                        },
                    },
                    {
                        type: 'message',
                        author: ADA,
                        content: `Completed {${TASK}}. Ask @Ada again, +@User is it good?`,
                        at: at(7),
                    },
                ],
                ...(working
                    ? {
                          working: [
                              {
                                  author: ADA,
                                  startedAt: at(1),
                                  steps: [{ kind: 'tool', tool: 'Read', text: 'docs/launch.md' }],
                              },
                          ],
                      }
                    : {}),
                readBy: [OWNER_ID],
            },
        ],
    });
}

async function renderThread(working = false) {
    const engine = referencesEngine(working);
    const app = renderWithProviders({ path: `/chats/${CHAT_ID}`, engineApi: engine.client });
    const history = await screen.findByRole('region', { name: 'Messages' });
    return { engine, app, history };
}

/** A chip of the finished reply once it renders as markdown: the plain-text fallback before it swaps out once. */
function replyChip(history: HTMLElement, name: string) {
    return waitFor(() => {
        const chip = within(history).getAllByRole('button', { name })[0];
        expect(chip?.closest('div.gap-3')).toBeTruthy();
        return chip as HTMLElement;
    });
}

describe('references in a thread', { timeout: TIMEOUT_MS }, () => {
    it('shows an agent hovercard on hover, with what it is doing, and Mention addresses it', async () => {
        const { history } = await renderThread(true);
        const chip = await replyChip(history, '@Ada');
        expect(within(history).getByText('asks you')).toBeDefined();
        fireEvent.pointerEnter(chip, { pointerType: 'mouse' });
        const card = await screen.findByRole('dialog', { name: 'Ada' });
        expect(chip.getAttribute('aria-expanded')).toBe('true');
        expect(within(card).getByText('Research')).toBeDefined();
        expect(within(card).getByText(/^Working · 1:00$/)).toBeDefined();
        expect(within(card).getByText('Read')).toBeDefined();
        expect(within(card).getByRole('link', { name: 'Open agent' }).getAttribute('href')).toBe(
            `/agents/${CHAT_AGENT_ID}`,
        );
        await expectNoAxeViolations(document.body);

        fireEvent.click(within(card).getByRole('button', { name: 'Mention' }));
        expect(screen.queryByRole('dialog', { name: 'Ada' })).toBeNull();
        const composer = screen.getByRole('textbox', { name: 'Message' });
        expect(composer.getAttribute('placeholder')).toBe('Message Ada…');
        expect(screen.getByRole('button', { name: 'Stop addressing Ada' })).toBeDefined();
        expect(document.activeElement).toBe(composer);
    });

    it('addresses the agent when its chip is clicked, and the message goes out as +@Name', async () => {
        const { engine, app, history } = await renderThread();
        await app.user.click(await replyChip(history, '@Ada'));
        await app.user.keyboard('Shorter, please{Enter}');
        await waitFor(() => {
            expect(engine.spies.sendMessage).toHaveBeenCalledOnce();
        });
        expect(engine.spies.sendMessage.mock.calls[0]?.[1].content).toBe('+@Ada Shorter, please');
        const sent = await within(history).findByText(
            (_content, element) => element?.tagName === 'P' && element.textContent === '@Ada Shorter, please',
        );
        expect(within(sent).getByRole('button', { name: '@Ada' })).toBeDefined();
        // The address stays for the next message until the member drops it.
        expect(screen.getByRole('button', { name: 'Stop addressing Ada' })).toBeDefined();
    });

    it('shows a task hovercard on keyboard focus with state, agent, detail, timer, commit and Open task', async () => {
        const { app, history } = await renderThread();
        const chip = await replyChip(history, TASK);
        chip.focus();
        // Focus from a script is not keyboard focus; Tab is.
        expect(screen.queryByRole('dialog', { name: TASK })).toBeNull();
        await app.user.click(chip);
        const card = await screen.findByRole('dialog', { name: TASK });
        expect(within(card).getByText('Completed')).toBeDefined();
        expect(within(card).getByText('@Ada')).toBeDefined();
        expect(within(card).getByText('Saved to docs/launch.md')).toBeDefined();
        expect(within(card).getByText('Took 0:21')).toBeDefined();
        expect(within(card).getByText('67b252c')).toBeDefined();
        const open = within(card).getByRole('link', { name: 'Open task' });
        expect(open.getAttribute('href')).toBe('/tasks/task-launch');
        // The peek card's footer action, which Enter anywhere in the card also opens.
        expect(open.getAttribute('aria-keyshortcuts')).toBe('Enter');
        await expectNoAxeViolations(document.body);

        await app.user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog', { name: TASK })).toBeNull();
    });
});
