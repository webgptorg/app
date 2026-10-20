import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createAgentsEngine } from '../../testing/agents-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse } from '../../testing/test-engine-api';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;

const rowOf = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement;

async function renderList(engine = createAgentsEngine({ agentCount: 6 })) {
    const app = renderWithProviders({ path: '/agents', engineApi: engine.client });
    await screen.findByRole('link', { name: 'Agent 001' });
    return { ...app, engine };
}

async function openRowMenu(user: ReturnType<typeof renderWithProviders>['user'], name: string) {
    await user.click(screen.getByRole('button', { name: `Actions for ${name}` }));
    return screen.getByRole('menu', { name: `Actions for ${name}` });
}

describe('deleting an agent', { timeout: TIMEOUT_MS }, () => {
    it('needs the exact name, then removes the agent, reports it and moves focus to the search', async () => {
        const { user, engine } = await renderList();
        await user.click(within(await openRowMenu(user, 'Agent 002')).getByRole('menuitem', { name: 'Delete' }));

        const dialog = screen.getByRole('dialog', { name: 'Delete Agent 002?' });
        const confirm = within(dialog).getByRole('button', { name: 'Delete' });
        const phrase = within(dialog).getByRole('textbox', { name: 'Type Agent 002 to confirm' });
        expect(confirm.hasAttribute('disabled')).toBe(true);
        await user.type(phrase, 'agent 002');
        expect(confirm.hasAttribute('disabled')).toBe(true);
        await user.clear(phrase);
        await user.type(phrase, 'Agent 002');
        expect(confirm.hasAttribute('disabled')).toBe(false);
        await user.click(confirm);

        expect(await screen.findByText('Agent 002 deleted')).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByRole('link', { name: 'Agent 002' })).toBeNull();
        });
        expect(screen.queryByRole('dialog', { name: 'Delete Agent 002?' })).toBeNull();
        expect(engine.spies.delete).toHaveBeenCalledOnce();
        await waitFor(() => {
            expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search agents' }));
        });
    });

    it('keeps the agent and the dialog on an API error, shows why, and can be retried', async () => {
        const { user, engine } = await renderList();
        engine.spies.delete.mockImplementationOnce(() => problemResponse('internal-error'));
        await user.click(within(await openRowMenu(user, 'Agent 003')).getByRole('menuitem', { name: 'Delete' }));
        const dialog = screen.getByRole('dialog', { name: 'Delete Agent 003?' });
        await user.type(within(dialog).getByRole('textbox'), 'Agent 003');
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

        expect(await within(dialog).findByRole('alert')).toBeDefined();
        expect(within(dialog).getByRole('alert').textContent).toContain('The engine did not delete the agent.');
        expect(await screen.findByText('The agent could not be deleted.')).toBeDefined();
        expect(screen.getByRole('link', { name: 'Agent 003' })).toBeDefined();

        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        expect(await screen.findByText('Agent 003 deleted')).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByRole('link', { name: 'Agent 003' })).toBeNull();
        });
        expect(engine.spies.delete).toHaveBeenCalledTimes(2);
    });

    it('says "not allowed" when the engine refuses with 403 an action the UI offered', async () => {
        const { user, engine } = await renderList();
        engine.spies.delete.mockImplementationOnce(() => problemResponse('forbidden'));
        await user.click(within(await openRowMenu(user, 'Agent 001')).getByRole('menuitem', { name: 'Delete' }));
        const dialog = screen.getByRole('dialog', { name: 'Delete Agent 001?' });
        await user.type(within(dialog).getByRole('textbox'), 'Agent 001');
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

        expect(await screen.findByText('Not allowed')).toBeDefined();
        expect(within(dialog).getByRole('alert').textContent).toContain('does not allow deleting');
    });

    it('opens the step-up dialog when the engine wants a fresh passkey check', async () => {
        const { user, engine } = await renderList(createAgentsEngine({ agentCount: 3 }));
        engine.spies.delete.mockImplementationOnce(() => problemResponse('step-up-required'));
        await user.click(within(await openRowMenu(user, 'Agent 001')).getByRole('menuitem', { name: 'Delete' }));
        const dialog = screen.getByRole('dialog', { name: 'Delete Agent 001?' });
        await user.type(within(dialog).getByRole('textbox'), 'Agent 001');
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
        expect(within(dialog).queryByRole('alert')).toBeNull();
        expect(screen.getByRole('link', { name: 'Agent 001' })).toBeDefined();
    });
});

describe('changing visibility', { timeout: TIMEOUT_MS }, () => {
    it('asks before making an agent public, and changes nothing when cancelled', async () => {
        const { user, engine } = await renderList();
        // Agent 003 starts private (index % 3 === 0).
        expect(within(rowOf('Agent 003')).getByText('Private')).toBeDefined();
        const trigger = screen.getByRole('button', { name: 'Actions for Agent 003' });
        await user.click(within(await openRowMenu(user, 'Agent 003')).getByRole('menuitem', { name: 'Make public' }));

        const dialog = screen.getByRole('dialog', { name: 'Make Agent 003 public?' });
        expect(dialog.textContent).toContain('without signing in');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(engine.spies.update).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(trigger);

        await user.click(within(await openRowMenu(user, 'Agent 003')).getByRole('menuitem', { name: 'Make public' }));
        await user.click(
            within(screen.getByRole('dialog', { name: 'Make Agent 003 public?' })).getByRole('button', {
                name: 'Make public',
            }),
        );
        expect(within(rowOf('Agent 003')).getByText('Public')).toBeDefined();
        expect(await screen.findByText('Agent 003 is now Public')).toBeDefined();
        expect(engine.spies.update).toHaveBeenCalledWith('agent-003', { visibility: 'public' }, expect.anything());
    });

    it('makes a public agent private without asking', async () => {
        const { user, engine } = await renderList();
        await user.click(within(await openRowMenu(user, 'Agent 001')).getByRole('menuitem', { name: 'Make private' }));
        expect(within(rowOf('Agent 001')).getByText('Private')).toBeDefined();
        await waitFor(() => {
            expect(engine.spies.update).toHaveBeenCalledWith('agent-001', { visibility: 'private' }, expect.anything());
        });
    });

    it('rolls the badge back and reports the failure when the engine refuses', async () => {
        const { user, engine } = await renderList();
        let refuse: () => void = () => undefined;
        engine.spies.update.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    refuse = () => {
                        void problemResponse('agent-deleted').then(resolve);
                    };
                }),
        );
        await user.click(within(await openRowMenu(user, 'Agent 001')).getByRole('menuitem', { name: 'Make private' }));
        expect(within(rowOf('Agent 001')).getByText('Private')).toBeDefined();

        refuse();
        expect(await screen.findByText('The visibility could not be changed.')).toBeDefined();
        await waitFor(() => {
            expect(within(rowOf('Agent 001')).getByText('Public')).toBeDefined();
        });
    });
});

describe('starting and stopping', { timeout: TIMEOUT_MS }, () => {
    it('updates the badge once the engine confirms, and reports each outcome', async () => {
        const { user, engine } = await renderList();
        // Agent 004 starts idle (index % 4 === 0).
        expect(await within(rowOf('Agent 004')).findByText('Idle')).toBeDefined();
        let confirm: () => void = () => undefined;
        const original = engine.agents.start;
        engine.spies.start.mockImplementationOnce(
            (agentId, signal) =>
                new Promise((resolve) => {
                    confirm = () => {
                        void original(agentId, signal).then(resolve);
                    };
                }),
        );
        await user.click(within(await openRowMenu(user, 'Agent 004')).getByRole('menuitem', { name: 'Start' }));
        expect(within(rowOf('Agent 004')).getByText('Idle')).toBeDefined();

        confirm();
        expect(await within(rowOf('Agent 004')).findByText('Running')).toBeDefined();
        expect(await screen.findByText('Agent 004 started')).toBeDefined();

        await user.click(within(await openRowMenu(user, 'Agent 004')).getByRole('menuitem', { name: 'Stop' }));
        expect(await within(rowOf('Agent 004')).findByText('Stopped')).toBeDefined();
        expect(await screen.findByText('Agent 004 stopped')).toBeDefined();
    });

    it('reports a failed start', async () => {
        const { user, engine } = await renderList();
        engine.spies.start.mockImplementationOnce(() => problemResponse('agent-deleted'));
        await user.click(within(await openRowMenu(user, 'Agent 004')).getByRole('menuitem', { name: 'Start' }));
        expect(await screen.findByText('The agent could not be started.')).toBeDefined();
    });

    it('reports a failed stop', async () => {
        const { user, engine } = await renderList();
        engine.spies.stop.mockImplementationOnce(() => problemResponse('not-found'));
        await user.click(within(await openRowMenu(user, 'Agent 001')).getByRole('menuitem', { name: 'Stop' }));
        expect(await screen.findByText('The agent could not be stopped.')).toBeDefined();
    });
});
