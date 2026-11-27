import type { ReadAgent, ReadChat, Timestamp } from '@ptbk/engine-api';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { TickerProvider } from '../../app/ticker';
import { createManualTicker } from '../../testing/manual-ticker';
import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render-ui';
import { MessageRow } from './message-row';
import type { StepsView, TaskView, ThreadView } from './message-views';
import { buildThreadReferences, ThreadReferencesProvider } from './references/thread-references';
import { StepsCard } from './steps-card';
import { TaskCard } from './task-card';
import { DayDivider } from './thread-time';

const NOW_MS = Date.parse('2026-11-13T12:16:00Z');
const at = (seconds: number) => new Date(NOW_MS + seconds * 1000).toISOString() as Timestamp;
const COPY = { kind: 'agent', key: 'agent-copy' } as const;
type ChatTask = ReadChat['tasks'][number];

const CHAT: Pick<ReadChat, 'members' | 'tasks' | 'working'> = {
    members: [{ ...COPY, name: 'Copywriter' }],
    tasks: [],
    working: [],
};
const PICTURED = {
    id: 'agent-copy',
    name: 'Copywriter',
    profile: { fullname: '', description: '', avatarUrl: '/agents/a.png', color: null },
} as unknown as ReadAgent;

/** A component inside a router (for Open task), the thread's references and a clock stopped at `NOW_MS`. */
function render(ui: ReactNode, options: { readonly canOpenTasks?: boolean; readonly agents?: ReadAgent[] } = {}) {
    const ticker = createManualTicker(NOW_MS);
    const references = buildThreadReferences({
        chat: CHAT,
        agents: options.agents ?? [],
        canOpenTasks: options.canOpenTasks ?? false,
        canOpenAgents: false,
    });
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => (
                <TickerProvider ticker={ticker}>
                    <ThreadReferencesProvider value={references}>{ui}</ThreadReferencesProvider>
                </TickerProvider>
            ),
        }),
        history: createMemoryHistory(),
    });
    const result = renderUi(<RouterProvider router={router} />);
    return { ...result, ticker };
}

function task(fields: Partial<ChatTask> = {}): ChatTask {
    return {
        name: 'Napsat text',
        taskId: null,
        detail: null,
        agentId: null,
        commit: null,
        reopened: false,
        startedAt: null,
        endedAt: null,
        state: 'queued',
        ...fields,
    };
}
const taskView = (value: ChatTask | null, agent: TaskView['agent'] = null): TaskView => ({
    kind: 'task',
    id: 'l1',
    createdAt: at(0),
    name: 'Napsat text',
    task: value,
    agent,
});

describe('TaskCard', () => {
    it('shows a completed task’s time, commit and Open task where tasks@1 leads', async () => {
        render(
            <TaskCard
                view={taskView(
                    task({
                        state: 'completed',
                        taskId: 'task-1' as ChatTask['taskId'],
                        commit: 'a1b2c3d4e5',
                        startedAt: at(-125),
                        endedAt: at(-5),
                        reopened: true,
                    }),
                )}
            />,
            { canOpenTasks: true },
        );
        const card = await screen.findByRole('region', { name: 'Napsat text' });
        expect(within(card).getByText('2 min 0 s')).toBeDefined();
        expect(within(card).getByText('· Reopened')).toBeDefined();
        expect(
            within(card)
                .getByText(/a1b2c3d$/)
                .getAttribute('title'),
        ).toBe('a1b2c3d4e5');
        const open = within(card).getByRole('link', { name: 'Open task' });
        expect(open.getAttribute('href')).toBe('/tasks/task-1');
        // A quiet chip on the card's wash, not an underlined text link.
        expect(open.className).toMatch(/\brounded-pill\b/);
        expect(open.className).not.toMatch(/(^|\s)underline\b/);
        await expectNoAxeViolations(card);
    });

    it('offers no Open task without tasks@1, and reads a task the thread no longer lists as unknown', async () => {
        const { unmount } = render(
            <TaskCard view={taskView(task({ state: 'completed', taskId: 'task-1' as ChatTask['taskId'] }))} />,
        );
        const card = await screen.findByRole('region', { name: 'Napsat text' });
        expect(within(card).queryByRole('link')).toBeNull();
        unmount();
        render(<TaskCard view={taskView(null)} />);
        expect(await screen.findByText('Unknown state')).toBeDefined();
    });
});

const steps = (fields: Partial<StepsView>): StepsView => ({
    kind: 'steps',
    id: 's',
    author: COPY,
    authorName: 'Copywriter',
    createdBy: null,
    createdAt: at(-8),
    status: 'done',
    steps: [{ kind: 'reasoning', tool: null, text: 'Who writes copy?', level: 'info' }],
    startedAt: at(-8),
    endedAt: at(0),
    ...fields,
});

describe('StepsCard', () => {
    it('says one step, and that a live turn is getting started before its first', async () => {
        const { unmount } = render(<StepsCard view={steps({})} />);
        expect(await screen.findByRole('button', { name: 'Worked 8 s · 1 step' })).toBeDefined();
        unmount();
        render(<StepsCard view={steps({ status: 'live', steps: [], endedAt: null })} />);
        expect(await screen.findByText('Getting started')).toBeDefined();
    });

    it('names an empty reasoning step and shows a warning note as text', async () => {
        render(
            <StepsCard
                view={steps({
                    status: 'unfinished',
                    steps: [
                        { kind: 'reasoning', tool: null, text: ' ', level: 'info' },
                        { kind: 'note', tool: null, text: '<b>Disk full</b>', level: 'warning' },
                    ],
                })}
            />,
        );
        expect(await screen.findByText('Thinking')).toBeDefined();
        expect(screen.getByText('<b>Disk full</b>')).toBeDefined();
        expect(document.querySelector('b')).toBeNull();
    });

    it('marks a turn that stopped without a reply neutral, or as trouble when its last step failed', async () => {
        const toneOf = async (level: 'info' | 'warning' | 'error') => {
            const { unmount } = render(
                <StepsCard
                    view={steps({
                        status: 'unfinished',
                        steps: [{ kind: 'tool', tool: 'Bash', text: 'ls', level }],
                    })}
                />,
            );
            const toggle = await screen.findByRole('button', { name: 'Stopped without a reply · 1 step' });
            const tone = toggle.querySelector('[data-tone]')?.getAttribute('data-tone');
            unmount();
            return tone;
        };
        expect(await toneOf('info')).toBe('quiet');
        expect(await toneOf('warning')).toBe('quiet');
        expect(await toneOf('error')).toBe('trouble');
    });
});

describe('MessageRow', () => {
    it('shows the agent’s picture when its profile has one', async () => {
        render(<MessageRow view={steps({})} startsTurn showAuthor onRetry={() => undefined} />, {
            agents: [PICTURED],
        });
        await screen.findByRole('button', { name: /Worked/ });
        expect(document.querySelector('img')?.getAttribute('src')).toBe('/agents/a.png');
    });

    it('lets a row that arrives now rise in, and one from earlier appear still', async () => {
        const view = (createdAt: string): ThreadView => ({
            kind: 'message',
            id: createdAt,
            author: COPY,
            authorName: 'Copywriter',
            createdBy: null,
            createdAt,
            text: 'Hi',
            markdown: false,
            state: null,
            retry: false,
            question: null,
            choices: [],
        });
        const fresh = new Date().toISOString();
        render(
            <>
                <MessageRow view={view(fresh)} startsTurn showAuthor onRetry={() => undefined} />
                <MessageRow view={view(at(-3600))} startsTurn showAuthor onRetry={() => undefined} />
            </>,
        );
        const [now, before] = await screen.findAllByRole('article');
        expect(now?.className).toContain('motion-safe:animate-rise-in');
        expect(before?.className).not.toContain('animate-rise-in');
    });
});

describe('DayDivider', () => {
    it('says Today, Yesterday, the day, and the year only for another year', async () => {
        render(
            <>
                <DayDivider at={at(-60)} />
                <DayDivider at={at(-86_400)} />
                <DayDivider at="2026-11-02T10:00:00Z" />
                <DayDivider at="2025-11-02T10:00:00Z" />
            </>,
        );
        const labels = (await screen.findAllByRole('separator')).map((divider) => divider.getAttribute('aria-label'));
        expect(labels).toEqual(['Today', 'Yesterday', 'Nov 2', 'Nov 2, 2025']);
    });
});
