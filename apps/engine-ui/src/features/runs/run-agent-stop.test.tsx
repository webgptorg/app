import { PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../testing/render-with-providers';
import { createRunsEngine, RUN_IDS } from '../../testing/runs-engine';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));

async function header(name: string) {
    const heading = await screen.findByRole('heading', { level: 1, name });
    return heading.closest('header') as HTMLElement;
}

describe('stopping an agent from its runs', { timeout: TIMEOUT_MS }, () => {
    it('offers neither Start nor Stop while the agent has nothing to do', async () => {
        const engine = createRunsEngine();
        renderWithProviders({ path: '/agents/agent-max', engineApi: engine.client });
        const max = await header('Max');
        expect(await within(max).findByText('Idle')).toBeDefined();
        expect(within(max).queryByRole('button', { name: /Start|Stop/ })).toBeNull();
        expect(engine.spies.list).not.toHaveBeenCalledWith(
            expect.objectContaining({ status: 'queued,running' }),
            expect.anything(),
        );
    });

    it('cancels the running work in one click, reports it, and shows "Stopping…" until the engine stops it', async () => {
        const engine = createRunsEngine();
        const { user } = renderWithProviders({ path: '/agents/agent-ada', engineApi: engine.client });
        const ada = await header('Ada');
        await user.click(await within(ada).findByRole('button', { name: 'Stop' }));

        expect(engine.spies.cancel).toHaveBeenCalledTimes(1);
        expect(engine.spies.cancel).toHaveBeenCalledWith(RUN_IDS.running, expect.anything());
        expect(await screen.findByText("Stopped Ada's work")).toBeDefined();
        const stopping = await within(ada).findByRole('button', { name: /Stopping…/ });
        expect((stopping as HTMLButtonElement).disabled).toBe(true);

        act(() => {
            engine.controller.advanceRun(RUN_IDS.running);
        });
        await waitFor(() => {
            expect(within(ada).queryByRole('button', { name: /Stop/ })).toBeNull();
        });
    });

    it('stops queued work too', async () => {
        const engine = createRunsEngine();
        const { user } = renderWithProviders({ path: '/agents/agent-grace', engineApi: engine.client });
        const grace = await header('Grace');
        expect(await within(grace).findByText('Waiting')).toBeDefined();
        await user.click(await within(grace).findByRole('button', { name: 'Stop' }));
        expect(engine.spies.cancel).toHaveBeenCalledWith(RUN_IDS.queued, expect.anything());
    });

    it('treats a run that finished in the meantime as stopped', async () => {
        const engine = createRunsEngine();
        engine.spies.cancel.mockImplementationOnce(() => problemResponse('run-finished'));
        const { user } = renderWithProviders({ path: '/agents/agent-ada', engineApi: engine.client });
        await user.click(await within(await header('Ada')).findByRole('button', { name: 'Stop' }));
        expect(await screen.findByText("Stopped Ada's work")).toBeDefined();
    });

    it('says so and offers Stop again when the engine refuses', async () => {
        const engine = createRunsEngine();
        engine.spies.cancel.mockImplementationOnce(() => problemResponse('validation-failed'));
        const { user } = renderWithProviders({ path: '/agents/agent-ada', engineApi: engine.client });
        const ada = await header('Ada');
        await user.click(await within(ada).findByRole('button', { name: 'Stop' }));
        expect(await screen.findByText('The agent could not be stopped.')).toBeDefined();
        expect(await within(ada).findByRole('button', { name: 'Stop' })).toBeDefined();
    });

    it('offers no Stop without runs.control', async () => {
        const engine = createRunsEngine({ permissions: allBut('runs.control') });
        renderWithProviders({ path: '/agents/agent-ada', engineApi: engine.client });
        const ada = await header('Ada');
        expect(await within(ada).findByText('Working')).toBeDefined();
        expect(within(ada).queryByRole('button', { name: /Stop/ })).toBeNull();
        expect(engine.spies.cancel).not.toHaveBeenCalled();
    });
});
