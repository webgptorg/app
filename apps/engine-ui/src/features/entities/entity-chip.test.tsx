import {
    AgentId,
    ChatId,
    FileId,
    IntegrationId,
    KNOWN_CAPABILITIES,
    MemberId,
    PERMISSIONS,
    RunId,
    TaskId,
    TriggerId,
} from '@ptbk/engine-api';
import { createDemoSeed, createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineApiOptions, InMemorySeedTask } from '@ptbk/engine-api/in-memory';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FEATURES } from '../../app/features';
import { defineFeature } from '../../app/registry/feature';
import { renderWithProviders } from '../../testing/render-with-providers';
import { EntityChip } from './entity-chip';
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
        expect(within(card).getByText('Task · 2026-10-30 09:00')).toBeTruthy();
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

/** Every kind of chip at once, on a card the agent overview shows: the full app around it, the demo engine behind it. */
function AllKinds() {
    return (
        <ul aria-label="All kinds">
            <li>
                <EntityChip kind="agent" id={AgentId.parse('agent-ada')} name="Ada" />
            </li>
            <li>
                <EntityChip
                    kind="task"
                    id={TaskId.parse('task-ship-billing')}
                    name="Ship billing v2 — 2026-10-30 09:00:00"
                />
            </li>
            <li>
                <EntityChip
                    kind="run"
                    id={RunId.parse('run-max-email')}
                    name="Email run"
                    status="live"
                    statusLabel="Running"
                />
            </li>
            <li>
                <EntityChip kind="chat" id={ChatId.parse('chat-copywriter')} name="Copy chat" />
            </li>
            <li>
                <EntityChip kind="file" id={FileId.parse('file-style-guide')} name="Style guide" />
            </li>
            <li>
                <EntityChip kind="trigger" id={TriggerId.parse('trigger-weekly-report')} name="Weekly trigger" />
            </li>
            <li>
                <EntityChip kind="integration" id={IntegrationId.parse('integration-github')} name="GitHub" />
            </li>
            <li>
                <EntityChip kind="member" id={MemberId.parse('member-jana')} name="Jana" />
            </li>
            <li>
                <EntityChip kind="run" id={RunId.parse('run-gone')} name="Gone run" />
            </li>
        </ul>
    );
}

const allKinds = defineFeature({
    id: 'test-all-kinds',
    requires: {},
    agentOverviewCards: [{ id: 'all-kinds', order: 1, component: AllKinds }],
});

describe('entity chips of every kind', { timeout: TIMEOUT_MS }, () => {
    it('link to their entity and show its key facts on hover, or a quiet line when the engine does not know it', async () => {
        const engineApi = createInMemoryEngineApiClient({
            clock: { now: () => TEST_NOW },
            seed: createDemoSeed(TEST_NOW),
        });
        const { user } = renderWithProviders({
            path: '/agents/agent-ada',
            engineApi,
            features: [...FEATURES, allKinds],
        });
        const list = await screen.findByRole('list', { name: 'All kinds' });
        const cases: readonly (readonly [string, string, RegExp | string])[] = [
            ['Ada', '/agents/agent-ada', 'Open agent'],
            ['Ship billing v2', '/tasks/task-ship-billing', 'Open task'],
            ['Email run, Running', '/runs/run-max-email', 'Open run'],
            ['Copy chat', '/chats/chat-copywriter', 'Open chat'],
            ['Style guide', '/files?file=file-style-guide', 'Open file'],
            ['Weekly trigger', '/triggers/trigger-weekly-report', 'Open trigger'],
            ['GitHub', '/integrations/integration-github', 'Open integration'],
            ['Jana', '/members', 'Open members'],
        ];
        for (const [name, href, open] of cases) {
            const chip = within(list).getByRole('link', { name });
            expect(chip.getAttribute('href')).toBe(href);
            await user.hover(chip);
            const card = await screen.findByRole('dialog');
            expect(await within(card).findByRole('link', { name: open })).toBeTruthy();
            await user.unhover(chip);
            await user.keyboard('{Escape}');
        }
        const gone = within(list).getByRole('link', { name: 'Gone run' });
        await user.hover(gone);
        expect(await screen.findByText('Details are not available right now.')).toBeTruthy();
    });

    it('names an entity without a link where its capability is missing', async () => {
        const engineApi = createInMemoryEngineApiClient({
            clock: { now: () => TEST_NOW },
            seed: createDemoSeed(TEST_NOW),
            capabilities: [KNOWN_CAPABILITIES.tasks],
        });
        renderWithProviders({ path: '/agents/agent-ada', engineApi, features: [...FEATURES, allKinds] });
        const list = await screen.findByRole('list', { name: 'All kinds' });
        expect(within(list).queryByRole('link', { name: /^Email run/ })).toBeNull();
        expect(within(list).getByText('Style guide').closest('a')).toBeNull();
        expect(within(list).getByRole('link', { name: 'Ship billing v2' })).toBeTruthy();
    });
});
