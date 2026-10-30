import { KNOWN_CAPABILITIES, PERMISSIONS, TriggerId } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { HOSTILE } from '../../testing/runs-engine';
import { problemResponse } from '../../testing/test-engine-api';
import { createTriggersEngine, INBOX_ADDRESS, TRIGGER_IDS, triggersSeed } from '../../testing/triggers-engine';
import type { TriggersEngine } from '../../testing/triggers-engine';

const TIMEOUT_MS = 20_000;
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));

async function renderTrigger(
    triggerId: string,
    engine: TriggersEngine = createTriggersEngine(),
    options: { readonly timeZone?: string } = {},
) {
    const app = renderWithProviders({ path: `/triggers/${triggerId}`, engineApi: engine.client, ...options });
    await screen.findByRole('heading', { level: 1, name: engine.controller.getTrigger(triggerId)?.name ?? '' });
    return { ...app, engine };
}

const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;
const fires = () => screen.getByRole('table', { name: 'History' });

describe('trigger detail', { timeout: TIMEOUT_MS }, () => {
    it('shows an email trigger’s engine-assigned address with a copy button', async () => {
        await renderTrigger(TRIGGER_IDS.inbox);
        const card = screen.getByRole('region', { name: 'Inbound email' });
        expect(within(card).getByText(INBOX_ADDRESS)).toBeDefined();
        expect(within(card).getByRole('button', { name: 'Copy address' })).toBeDefined();
        expect(within(fact('Kind')).getByText('Email')).toBeDefined();
        expect(within(fact('Agent')).getByRole('link', { name: 'Ada' }).getAttribute('href')).toBe('/agents/agent-ada');
    });

    it('describes a schedule in words with its cron, zone, range, runs and the message as text', async () => {
        await renderTrigger(TRIGGER_IDS.weekday);
        const card = screen.getByRole('region', { name: 'Schedule' });
        expect(within(card).getByText('Every weekday at 08:00, Europe/Prague')).toBeDefined();
        expect(within(card).getByText('0 8 * * 1-5')).toBeDefined();
        expect(within(card).getByText('Europe/Prague', { selector: 'dd' })).toBeDefined();
        expect(within(card).getByText('2 runs')).toBeDefined();
        expect(within(card).getByText('Never')).toBeDefined();
        // Typed by a member and sent to the agent: shown as text, never as markup.
        expect(within(card).getByText(`Write the morning report. ${HOSTILE}`)).toBeDefined();
        expect(card.querySelector('img, script, a[href^="javascript:"]')).toBeNull();
    });

    it('shows next and last fire in the reader’s zone with the schedule’s zone beside it, and ticks', async () => {
        const { ticker } = await renderTrigger(TRIGGER_IDS.weekday);
        const next = fact('Next run');
        expect(within(next).getByText(/^Oct 2, 2026, 6:00\sAM$/)).toBeDefined();
        expect(within(next).getByText(/^\(Oct 2, 2026, 8:00\sAM, Europe\/Prague\)$/)).toBeDefined();
        expect(next.textContent).toMatch(/Oct 2, 2026, 6:00\sAM \(Oct 2, 2026, 8:00\sAM, Europe\/Prague\)/);
        expect(within(next).getByText('in 18 hours')).toBeDefined();
        ticker.advance(17.5 * 3_600_000);
        expect(within(next).getByText('in 30 minutes')).toBeDefined();
        expect(within(fact('Last run')).getByText(/Europe\/Prague\)$/)).toBeDefined();
    });

    it('shows one time when the reader is in the schedule’s zone', async () => {
        await renderTrigger(TRIGGER_IDS.weekday, createTriggersEngine(), { timeZone: 'Europe/Prague' });
        expect(within(fact('Next run')).getByText(/^Oct 2, 2026, 8:00\sAM$/)).toBeDefined();
    });

    it('lists fires newest first with outcome, error as text and a link to the run', async () => {
        await renderTrigger(TRIGGER_IDS.weekday);
        const rows = await waitFor(() => {
            const found = within(fires()).getAllByRole('row').slice(1);
            expect(found).toHaveLength(2);
            return found;
        });
        const [started, failed] = rows as [HTMLElement, HTMLElement];
        expect(within(started).getByText('Started a run')).toBeDefined();
        expect(within(started).getByRole('link', { name: 'Open run' }).getAttribute('href')).toBe('/runs/run-morning');
        expect(within(failed).getByText('Failed')).toBeDefined();
        expect(within(failed).getByText(`Nothing ran: ${HOSTILE}`)).toBeDefined();
        expect(within(failed).queryByRole('link')).toBeNull();
        expect(fires().querySelector('img, script')).toBeNull();
    });

    it('links fires to runs only when the engine advertises runs@1', async () => {
        const without = Object.values(KNOWN_CAPABILITIES).filter(({ id }) => id !== 'runs');
        await renderTrigger(TRIGGER_IDS.weekday, createTriggersEngine({ capabilities: without }));
        expect(await within(fires()).findByText('Started a run')).toBeDefined();
        expect(within(fires()).queryByRole('columnheader', { name: 'Run' })).toBeNull();
        expect(within(fires()).queryByRole('link')).toBeNull();
    });

    it('pages through a long fire history on the engine', async () => {
        const seed = triggersSeed();
        const many = Array.from({ length: 57 }, (_, index) => ({
            id: `fire-${String(index).padStart(3, '0')}`,
            at: new Date(Date.UTC(2026, 6, 1) + index * 86_400_000).toISOString(),
            outcome: 'skipped' as const,
            runId: null,
            error: null,
        }));
        const engine = createTriggersEngine({
            seed: {
                ...seed,
                triggers: (seed.triggers ?? []).map((entry) =>
                    entry.trigger.id === TRIGGER_IDS.paused ? { ...entry, fires: many } : entry,
                ),
            },
        });
        const { user } = await renderTrigger(TRIGGER_IDS.paused, engine);
        await waitFor(() => {
            expect(within(fires()).getAllByRole('row')).toHaveLength(51);
        });
        await user.click(screen.getByRole('button', { name: 'Next page' }));
        await waitFor(() => {
            expect(within(fires()).getAllByRole('row')).toHaveLength(8);
        });
        expect(engine.spies.listFires.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: expect.any(String) as string });
    });

    it('says when a trigger has not fired yet', async () => {
        await renderTrigger(TRIGGER_IDS.inbox);
        expect(await within(fires()).findByText('Not run yet')).toBeDefined();
    });

    it('updates its fire history and last fire live when the trigger fires', async () => {
        const { engine } = await renderTrigger(TRIGGER_IDS.inbox);
        expect(await within(fires()).findByText('Not run yet')).toBeDefined();
        act(() => {
            engine.controller.fireTrigger(TRIGGER_IDS.inbox, { subject: 'Refund please' });
        });
        expect(await within(fires()).findByText('Started a run')).toBeDefined();
        await waitFor(() => {
            expect(within(fact('Last run')).queryByText('Never')).toBeNull();
        });
    });

    it('explains a failed trigger and offers resume', async () => {
        await renderTrigger(TRIGGER_IDS.failed);
        expect(screen.getByText('This trigger failed')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Resume Calendar sync' })).toBeDefined();
    });

    it('leads back to all triggers, or to the agent’s tab it was opened from', async () => {
        await renderTrigger(TRIGGER_IDS.weekday);
        expect(screen.getByRole('link', { name: 'Back to triggers' }).getAttribute('href')).toBe('/triggers');
    });

    it('leads back to the agent’s tab and returns there after a delete', async () => {
        const engine = createTriggersEngine();
        const app = renderWithProviders({
            path: `/triggers/${TRIGGER_IDS.weekday}?from=agent`,
            engineApi: engine.client,
        });
        await screen.findByRole('heading', { level: 1, name: 'Morning report' });
        const back = await screen.findByRole('link', { name: "Back to Iris's triggers" });
        expect(back.getAttribute('href')).toBe('/agents/agent-iris/triggers');
        expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(
            `/triggers/${TRIGGER_IDS.weekday}/edit?from=agent`,
        );
        await app.user.click(screen.getByRole('button', { name: 'More actions' }));
        await app.user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
        const dialog = await screen.findByRole('dialog', { name: 'Delete Morning report?' });
        await app.user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        await waitFor(() => {
            expect(app.router.state.location.pathname).toBe('/agents/agent-iris/triggers');
        });
    });

    it('says why an ended trigger ended and offers no pause, resume or edit', async () => {
        await renderTrigger(TRIGGER_IDS.ended);
        expect(within(fact('State')).getByText('Its schedule is over')).toBeDefined();
        expect(screen.queryByRole('button', { name: /^(Pause|Resume) / })).toBeNull();
        expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
        expect(screen.getByRole('button', { name: 'More actions' })).toBeDefined();
    });

    it('describes a newer engine’s recurrence by its name and offers no edit that would replace it', async () => {
        const engine = createTriggersEngine();
        const real = await engine.client.triggers.get(TriggerId.parse(TRIGGER_IDS.weekday), AbortSignal.timeout(1_000));
        if (real.kind !== 'ok' || real.data.kind !== 'schedule') throw new Error('The seed has no schedule');
        const recurrence = { kind: 'unknown', rawKind: 'sunrise' } as unknown as typeof real.data.config.recurrence;
        const newer = { ...real.data, config: { ...real.data.config, recurrence } };
        engine.spies.get.mockImplementation(() => Promise.resolve({ ...real, data: newer }));
        await renderTrigger(TRIGGER_IDS.weekday, engine);
        expect(within(screen.getByRole('region', { name: 'Schedule' })).getByText('sunrise')).toBeDefined();
        expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Pause Morning report' })).toBeDefined();
    });

    it('deletes after a confirmation naming the trigger, waiting for the engine', async () => {
        const { user, engine, router } = await renderTrigger(TRIGGER_IDS.weekday);
        await user.click(screen.getByRole('button', { name: 'More actions' }));
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        const dialog = await screen.findByRole('dialog', { name: 'Delete Morning report?' });
        expect(within(dialog).getByText(/The runs it already started are kept/)).toBeDefined();
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        expect(await screen.findByText('Morning report deleted.')).toBeDefined();
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/triggers');
        });
        expect(engine.controller.getTrigger(TRIGGER_IDS.weekday)).toBeUndefined();
    });

    it('keeps the dialog open and reports a refused delete', async () => {
        const engine = createTriggersEngine();
        engine.spies.delete.mockImplementationOnce(() => problemResponse('validation-failed'));
        const { user, router } = await renderTrigger(TRIGGER_IDS.weekday, engine);
        await user.click(screen.getByRole('button', { name: 'More actions' }));
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        const dialog = await screen.findByRole('dialog', { name: 'Delete Morning report?' });
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        expect(await screen.findByText('Morning report could not be deleted.')).toBeDefined();
        expect(screen.getByRole('dialog', { name: 'Delete Morning report?' })).toBeDefined();
        expect(router.state.location.pathname).toBe(`/triggers/${TRIGGER_IDS.weekday}`);
    });

    it('offers no pause, edit or delete without triggers.manage', async () => {
        await renderTrigger(TRIGGER_IDS.weekday, createTriggersEngine({ permissions: allBut('triggers.manage') }));
        expect(screen.queryByRole('button', { name: /^(Pause|Resume) / })).toBeNull();
        expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    });

    it('shows a skeleton while loading, then the trigger', async () => {
        const engine = createTriggersEngine();
        let release: () => void = () => undefined;
        // Once released, the call goes through the spy again, which then answers as the engine.
        const original: typeof engine.client.triggers.get = (triggerId, signal) =>
            engine.client.triggers.get(triggerId, signal);
        engine.spies.get.mockImplementationOnce(
            (triggerId, signal) =>
                new Promise((resolve) => {
                    release = () => {
                        void original(triggerId, signal).then(resolve);
                    };
                }),
        );
        renderWithProviders({ path: `/triggers/${TRIGGER_IDS.weekday}`, engineApi: engine.client });
        expect(await screen.findByRole('region', { name: 'Trigger', busy: true })).toBeDefined();
        release();
        expect(await screen.findByRole('heading', { level: 1, name: 'Morning report' })).toBeDefined();
    });

    it('says a trigger does not exist, and offers the way back', async () => {
        renderWithProviders({ path: '/triggers/trigger-gone', engineApi: createTriggersEngine().client });
        expect(await screen.findByRole('heading', { level: 1, name: 'Trigger not found' })).toBeDefined();
        expect(screen.getByRole('link', { name: 'Back to triggers' }).getAttribute('href')).toBe('/triggers');
    });

    it('shows an error with retry when the trigger cannot be loaded', async () => {
        const engine = createTriggersEngine();
        engine.spies.get.mockImplementation(() => problemResponse('validation-failed'));
        const { user } = renderWithProviders({ path: `/triggers/${TRIGGER_IDS.weekday}`, engineApi: engine.client });
        expect(await screen.findByText('The trigger could not be loaded.')).toBeDefined();
        engine.spies.get.mockRestore();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Morning report' })).toBeDefined();
    });

    it('has no axe violations', async () => {
        const { container } = await renderTrigger(TRIGGER_IDS.weekday);
        await within(fires()).findByText('Started a run');
        await expectNoAxeViolations(container);
    });
});
