import { PERMISSIONS } from '@ptbk/engine-api';
import { createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineApiOptions, InMemorySeedTask } from '@ptbk/engine-api/in-memory';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../testing/render-with-providers';
import { HOSTILE } from '../../testing/runs-engine';
import { TEST_NOW } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const AT = TEST_NOW.toISOString();

type SeedTask = InMemorySeedTask['task'];

function task(id: string, name: string, fields: Partial<SeedTask> = {}): SeedTask {
    return {
        id,
        name,
        kind: 'ordinary',
        purpose: null,
        core: false,
        agentId: null,
        executor: null,
        priority: { rank: 0, text: null },
        state: 'ready',
        stateReason: null,
        next: null,
        conditions: [],
        repeat: null,
        notBefore: null,
        dueAt: null,
        nextAt: null,
        progress: null,
        parent: null,
        dependsOn: [],
        origin: null,
        doneCount: 0,
        lastDoneAt: null,
        reopened: false,
        sourcePath: null,
        allowedActions: [],
        updatedAt: AT,
        ...fields,
    };
}

const HOSTILE_TASK = `${HOSTILE} — 2026-10-30 09:00:00`;
const HOSTILE_AGENT = `Agent ${HOSTILE}`;

function engine(options: InMemoryEngineApiOptions = {}) {
    return createInMemoryEngineApiClient({
        clock: { now: () => TEST_NOW },
        seed: {
            agents: [{ id: 'agent-ada', source: 'Ada\nPERSONA Reviews pull requests' }],
            tasks: [
                {
                    task: task('task-main', 'Main task', {
                        agentId: 'agent-ada',
                        agentName: 'Ada',
                        dependsOn: [{ taskId: 'task-hostile', name: HOSTILE_TASK, state: 'pending' }],
                    }),
                    links: [
                        { direction: 'outgoing', target: { type: 'agent', agentId: 'agent-ada', name: HOSTILE_AGENT } },
                    ],
                },
                { task: task('task-hostile', HOSTILE_TASK, { state: 'blocked', stateReason: HOSTILE }) },
            ],
        },
        ...options,
    });
}

describe('entity chips', { timeout: TIMEOUT_MS }, () => {
    it('render engine names as text only, with the readable part of a task name, and link to the entity', async () => {
        const { container } = renderWithProviders({ path: '/tasks/task-main', engineApi: engine() });
        const related = await screen.findByRole('region', { name: 'Related' });
        expect(container.querySelector('img[src="x"], script')).toBeNull();
        const hostileTask = within(related).getByRole('link', { name: HOSTILE });
        expect(hostileTask.getAttribute('href')).toBe('/tasks/task-hostile');
        // The instance stamp stays out of the chip; the card and the detail page show it.
        expect(hostileTask.textContent).not.toContain('2026-10-30');
        const hostileAgent = within(related).getByRole('link', { name: HOSTILE_AGENT });
        expect(hostileAgent.getAttribute('href')).toBe('/agents/agent-ada');
    });

    it('opens a card with the key facts on hover, as a dialog the keyboard can reach', async () => {
        const { user } = renderWithProviders({ path: '/tasks/task-main', engineApi: engine() });
        const related = await screen.findByRole('region', { name: 'Related' });
        const chip = within(related).getByRole('link', { name: HOSTILE });
        expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
        await user.hover(chip);
        const card = await screen.findByRole('dialog', { name: HOSTILE_TASK });
        expect(await within(card).findByText('Blocked')).toBeTruthy();
        expect(within(card).getByText('2026-10-30 09:00')).toBeTruthy();
        // The readable name and the engine's reason, both as text.
        expect(within(card).getAllByText(HOSTILE)).toHaveLength(2);
        expect(within(card).getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe('/tasks/task-hostile');
        expect(card.querySelector('img, script')).toBeNull();
    });

    it('is a plain chip, with no link or card, for an entity the member may not open', async () => {
        renderWithProviders({
            path: '/tasks/task-main',
            engineApi: engine({
                member: {
                    id: 'member-owner',
                    role: 'member',
                    permissions: PERMISSIONS.filter((permission) => permission !== 'agents.read'),
                },
            }),
        });
        const related = await screen.findByRole('region', { name: 'Related' });
        expect(within(related).queryByRole('link', { name: HOSTILE_AGENT })).toBeNull();
        expect(within(related).getByText(HOSTILE_AGENT).closest('a, button')).toBeNull();
        // Tasks the member may read stay links.
        expect(within(related).getByRole('link', { name: HOSTILE }).getAttribute('href')).toBe('/tasks/task-hostile');
    });
});
