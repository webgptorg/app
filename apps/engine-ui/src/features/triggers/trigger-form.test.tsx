import { createProblem, PERMISSIONS } from '@ptbk/engine-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { m } from '../../paraglide/messages';
import { expectNoAxeViolations } from '../../testing/axe';
import { createManualTicker } from '../../testing/manual-ticker';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createTriggersEngine, TRIGGER_IDS } from '../../testing/triggers-engine';
import type { TriggersEngine } from '../../testing/triggers-engine';

const TIMEOUT_MS = 20_000;

async function renderForm(
    path = '/triggers/new',
    engine: TriggersEngine = createTriggersEngine(),
    options: { readonly now?: string } = {},
) {
    const app = renderWithProviders({
        path,
        engineApi: engine.client,
        ...(options.now === undefined ? {} : { ticker: createManualTicker(Date.parse(options.now)) }),
    });
    await screen.findByRole('button', { name: /^(Create trigger|Save)$/ });
    // The agent picker fills from the engine; wait so a choice is not lost to the first render.
    await screen.findByRole('option', { name: 'Iris', hidden: true });
    return { ...app, engine };
}

/** The labelled control itself, not an open list's popup, which takes the same name. */
const field = (name: RegExp | string) => {
    const found = screen
        .getAllByLabelText(name)
        .find(
            (element) =>
                element.getAttribute('role') !== 'listbox' &&
                !(element instanceof HTMLInputElement && element.getAttribute('role') === 'combobox'),
        );
    if (found === undefined) throw new Error(`No control labelled ${String(name)}`);
    return found;
};
/** The list a combobox opens. */
const listOf = (control: HTMLElement) =>
    document.getElementById(control.getAttribute('aria-controls') ?? '') as HTMLElement;
/** What a combobox holds: the value its hidden input posts. */
const chosen = (name: string) =>
    document.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)?.value;

/** Opens a combobox and picks an option by its name; a searchable one is narrowed by typing first. */
async function choose(app: { readonly user: UserEvent }, label: RegExp, option: string) {
    const control = field(label);
    await app.user.click(control);
    if (document.activeElement instanceof HTMLInputElement) await app.user.keyboard(option);
    await app.user.click(within(listOf(control)).getByRole('option', { name: option }));
}
const errorOf = (control: HTMLElement) => {
    const id = control.getAttribute('aria-describedby') ?? '';
    return id
        .split(' ')
        .map((each) => document.getElementById(each)?.textContent ?? '')
        .join(' ');
};
const preview = () => screen.getByRole('region', { name: 'Next runs' });

async function fillSchedule(app: Awaited<ReturnType<typeof renderForm>>, expression: string, timeZone: string) {
    await choose(app, /^Agent/, 'Iris');
    await app.user.type(field(/^Name/), 'Night shift');
    await choose(app, /^Repeats/, 'Custom (cron)');
    await app.user.clear(field(/^Cron expression/));
    await app.user.type(field(/^Cron expression/), expression);
    await choose(app, /^Time zone/, timeZone);
    await app.user.type(field(/^Message/), 'Tidy the inbox.');
}

describe('trigger form', { timeout: TIMEOUT_MS }, () => {
    it('blocks a submit with invalid local input and names what is wrong on each field', async () => {
        const app = await renderForm();
        await choose(app, /^Repeats/, 'Custom (cron)');
        await app.user.clear(field(/^Cron expression/));
        await app.user.type(field(/^Cron expression/), '0 8 * * MON');
        await app.user.click(screen.getByRole('button', { name: 'Create trigger' }));
        expect(await screen.findByText('Choose the agent this trigger starts.')).toBeDefined();
        expect(errorOf(field(/^Name/))).toContain('Give the trigger a name.');
        expect(errorOf(field(/^Cron expression/))).toContain('Enter five fields of numbers');
        expect(errorOf(field(/^Message/))).toContain('Write what the agent should do.');
        expect(app.engine.spies.create).not.toHaveBeenCalled();
    });

    it('checks an interval’s range and an end before the start', async () => {
        const app = await renderForm();
        await choose(app, /^Repeats/, 'At a fixed interval');
        await app.user.clear(field(/^Every/));
        await app.user.type(field(/^Every/), '400');
        await choose(app, /^Unit/, 'Days');
        fireEvent.change(field(/^Starts/), { target: { value: '2026-10-05T10:00' } });
        fireEvent.change(field(/^Ends/), { target: { value: '2026-10-05T09:00' } });
        await app.user.click(screen.getByRole('button', { name: 'Create trigger' }));
        expect(await screen.findByText('Choose an interval from 1 minute to 366 days.')).toBeDefined();
        expect(errorOf(field(/^Ends/))).toContain('The end must be after the start.');
        expect(app.engine.spies.create).not.toHaveBeenCalled();
    });

    it('offers webhooks only as coming later', async () => {
        await renderForm();
        const webhook = within(listOf(field(/^Kind/))).getByRole('option', {
            name: 'Webhook (coming later)',
            hidden: true,
        });
        expect(webhook.getAttribute('aria-disabled')).toBe('true');
    });

    it('previews the next five fires as an estimate, in both zones', async () => {
        const app = await renderForm('/triggers/new', createTriggersEngine(), { now: '2026-10-01T12:00:00Z' });
        await fillSchedule(app, '0 8 * * 1-5', 'Europe/Prague');
        const items = await within(preview()).findAllByRole('listitem');
        expect(items.map((item) => item.textContent)).toEqual(
            ['Oct 2', 'Oct 5', 'Oct 6', 'Oct 7', 'Oct 8'].map((day): unknown =>
                expect.stringMatching(
                    new RegExp(`^${day}, 2026, 6:00\\sAM \\(${day}, 2026, 8:00\\sAM, Europe/Prague\\)$`),
                ),
            ),
        );
        expect(within(preview()).getByText('Every weekday at 08:00, Europe/Prague')).toBeDefined();
        expect(within(preview()).getByText(/^An estimate from your browser/)).toBeDefined();
    });

    it('previews as soon as the schedule’s own fields are valid, before a name or message', async () => {
        await renderForm();
        expect(within(preview()).getByText('Every weekday at 09:00, UTC')).toBeDefined();
        expect(within(preview()).getAllByRole('listitem')).toHaveLength(5);
    });

    it('previews a Prague 02:30 cron twice on the October night the hour repeats', async () => {
        const app = await renderForm('/triggers/new', createTriggersEngine(), { now: '2026-10-24T00:00:00Z' });
        await fillSchedule(app, '30 2 * * *', 'Europe/Prague');
        const items = await within(preview()).findAllByRole('listitem');
        expect(items.map((item) => item.querySelector('time')?.getAttribute('dateTime'))).toEqual([
            '2026-10-24T00:30:00.000Z',
            '2026-10-25T00:30:00.000Z',
            '2026-10-25T01:30:00.000Z',
            '2026-10-26T01:30:00.000Z',
            '2026-10-27T01:30:00.000Z',
        ]);
        for (const item of items) expect(item.textContent).toMatch(/\(Oct 2\d, 2026, 2:30\sAM, Europe\/Prague\)$/);
    });

    it('previews no Prague 02:30 fire on the March night the clocks skip it', async () => {
        const app = await renderForm('/triggers/new', createTriggersEngine(), { now: '2027-03-27T00:00:00Z' });
        await fillSchedule(app, '30 2 * * *', 'Europe/Prague');
        const items = await within(preview()).findAllByRole('listitem');
        expect(items.map((item) => item.querySelector('time')?.getAttribute('dateTime')).slice(0, 3)).toEqual([
            '2027-03-27T01:30:00.000Z',
            '2027-03-29T00:30:00.000Z',
            '2027-03-30T00:30:00.000Z',
        ]);
    });

    it('lets the engine judge a schedule the preview finds no fire for, and puts its 422 on the field', async () => {
        const app = await renderForm();
        await fillSchedule(app, '0 0 30 2 *', 'Europe/Prague');
        expect(await within(preview()).findByText('This schedule would never run.')).toBeDefined();
        await app.user.click(screen.getByRole('button', { name: 'Create trigger' }));
        await waitFor(() => {
            expect(errorOf(field(/^Cron expression/))).toContain('The expression never fires.');
        });
        expect(app.engine.spies.create).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('The project refused the trigger')).toBeNull();
        expect(app.router.state.location.pathname).toBe('/triggers/new');
    });

    it('shows a 422 it cannot place on a field above the form', async () => {
        const engine = createTriggersEngine();
        engine.spies.create.mockImplementationOnce(() =>
            Promise.resolve({
                kind: 'problem',
                problem: createProblem('invalid-schedule', { detail: 'The scheduler is full this hour.' }),
            }),
        );
        const app = await renderForm('/triggers/new', engine);
        await fillSchedule(app, '0 8 * * *', 'Europe/Prague');
        await app.user.click(screen.getByRole('button', { name: 'Create trigger' }));
        const banner = (await screen.findByText('The project refused the trigger')).closest('[role="alert"]');
        expect(banner?.textContent).toContain('The scheduler is full this hour.');
    });

    it('creates a schedule with times read in its zone, then opens it', async () => {
        const app = await renderForm('/triggers/new?agentId=agent-iris');
        expect(chosen('agentId')).toBe('agent-iris');
        const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
        expect((await trail.findByRole('link', { name: 'Iris' })).getAttribute('href')).toBe('/agents/agent-iris');
        expect(trail.getByRole('link', { name: 'Triggers' }).getAttribute('href')).toBe('/agents/agent-iris/triggers');
        expect(field(/^Agent/).textContent).toContain('Iris');
        await app.user.type(field(/^Name/), 'Weekly digest');
        await choose(app, /^Repeats/, 'At a fixed interval');
        await app.user.clear(field(/^Every/));
        await app.user.type(field(/^Every/), '2');
        await choose(app, /^Time zone/, 'Europe/Prague');
        fireEvent.change(field(/^Starts/), { target: { value: '2026-10-02T09:00' } });
        await app.user.type(field(/^Maximum runs/), '10');
        await app.user.type(field(/^Message/), 'Send the digest.');
        await app.user.click(screen.getByRole('button', { name: 'Create trigger' }));
        await waitFor(() => {
            expect(app.engine.spies.create).toHaveBeenCalledWith(
                {
                    kind: 'schedule',
                    agentId: 'agent-iris',
                    name: 'Weekly digest',
                    recurrence: { kind: 'interval', everySeconds: 7_200 },
                    startsAt: '2026-10-02T07:00:00.000Z',
                    endsAt: null,
                    maxRunCount: 10,
                    message: 'Send the digest.',
                },
                expect.anything(),
            );
        });
        expect(await screen.findByRole('heading', { level: 1, name: 'Weekly digest' })).toBeDefined();
        expect(screen.getByText('Weekly digest created.')).toBeDefined();
        expect(screen.getByText('Every 2 hours')).toBeDefined();
    });

    it('creates an email trigger from an agent and a name, and shows the address the engine assigns', async () => {
        const app = await renderForm();
        await choose(app, /^Kind/, 'Email');
        expect(screen.queryByLabelText(/^Message/)).toBeNull();
        expect(screen.queryByRole('region', { name: 'Next runs' })).toBeNull();
        await choose(app, /^Agent/, 'Ada');
        await app.user.type(field(/^Name/), 'Orders inbox');
        await app.user.click(screen.getByRole('button', { name: 'Create trigger' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Orders inbox' })).toBeDefined();
        expect(app.engine.spies.create).toHaveBeenCalledWith(
            { kind: 'email', agentId: 'agent-ada', name: 'Orders inbox' },
            expect.anything(),
        );
        const card = screen.getByRole('region', { name: 'Inbound email' });
        expect(within(card).getByText(/@/)).toBeDefined();
        expect(within(card).getByRole('button', { name: 'Copy address' })).toBeDefined();
    });

    it('edits a schedule with its own zone and values filled in, a cron it would write as its preset', async () => {
        const app = await renderForm(`/triggers/${TRIGGER_IDS.weekday}/edit`);
        expect(field(/^Name/)).toHaveProperty('value', 'Morning report');
        expect(chosen('recurrence')).toBe('weekdays');
        expect(field(/^Time(?! zone)/)).toHaveProperty('value', '08:00');
        expect(screen.queryByLabelText(/^Cron expression/)).toBeNull();
        expect(chosen('timeZone')).toBe('Europe/Prague');
        expect(field(/^Agent/)).toHaveProperty('disabled', true);
        expect(screen.queryByLabelText(/^Kind/)).toBeNull();
        fireEvent.change(field(/^Time(?! zone)/), { target: { value: '09:00' } });
        await app.user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(app.engine.spies.update).toHaveBeenCalledWith(
                TRIGGER_IDS.weekday,
                expect.objectContaining({
                    name: 'Morning report',
                    recurrence: { kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Europe/Prague' },
                }),
                expect.anything(),
            );
        });
        expect(await screen.findByText('Every weekday at 09:00, Europe/Prague')).toBeDefined();
        expect(app.router.state.location.pathname).toBe(`/triggers/${TRIGGER_IDS.weekday}`);
    });

    it('starts on every weekday at 09:00 and offers the presets before once, interval and custom cron', async () => {
        await renderForm();
        expect(chosen('recurrence')).toBe('weekdays');
        expect(field(/^Repeats/).textContent).toBe('Every weekday (Monday to Friday)');
        expect(field(/^Time(?! zone)/)).toHaveProperty('value', '09:00');
        expect(
            within(listOf(field(/^Repeats/)))
                .getAllByRole('option', { hidden: true })
                .map((option) => option.textContent),
        ).toEqual([
            'Every hour',
            'Every day',
            'Every weekday (Monday to Friday)',
            'Every week',
            'Once',
            'At a fixed interval',
            'Custom (cron)',
        ]);
    });

    it('creates a weekly schedule from a day and a time, previewed in words with its zone', async () => {
        const app = await renderForm('/triggers/new', createTriggersEngine(), { now: '2026-10-01T12:00:00Z' });
        await choose(app, /^Agent/, 'Iris');
        await app.user.type(field(/^Name/), 'Friday wrap-up');
        await choose(app, /^Repeats/, 'Every week');
        await choose(app, /^Day/, 'Friday');
        fireEvent.change(field(/^Time(?! zone)/), { target: { value: '16:30' } });
        await choose(app, /^Time zone/, 'Europe/Prague');
        await app.user.type(field(/^Message/), 'Sum up the week.');
        expect(within(preview()).getByText('Every Friday at 16:30, Europe/Prague')).toBeDefined();
        await app.user.click(screen.getByRole('button', { name: 'Create trigger' }));
        await waitFor(() => {
            expect(app.engine.spies.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    recurrence: { kind: 'cron', expression: '30 16 * * 5', timeZone: 'Europe/Prague' },
                }),
                expect.anything(),
            );
        });
    });

    it('starts a custom cron from the preset it replaces', async () => {
        const app = await renderForm();
        await choose(app, /^Repeats/, 'Every day');
        fireEvent.change(field(/^Time(?! zone)/), { target: { value: '07:45' } });
        await choose(app, /^Repeats/, 'Custom (cron)');
        expect(field(/^Cron expression/)).toHaveProperty('value', '45 7 * * *');
    });

    it('refuses a preset without a time, on the time field', async () => {
        const app = await renderForm();
        await choose(app, /^Repeats/, 'Every day');
        fireEvent.change(field(/^Time(?! zone)/), { target: { value: '' } });
        await app.user.click(screen.getByRole('button', { name: 'Create trigger' }));
        await waitFor(() => {
            expect(errorOf(field(/^Time(?! zone)/))).toContain('Enter a time.');
        });
        expect(within(preview()).getByText('Fill in the schedule to see when it runs.')).toBeDefined();
        expect(app.engine.spies.create).not.toHaveBeenCalled();
    });

    it('opens a cron no preset writes as custom, keeping it as typed', async () => {
        const engine = createTriggersEngine();
        const app = await renderForm(`/triggers/${TRIGGER_IDS.weekday}/edit`, engine);
        await choose(app, /^Repeats/, 'Custom (cron)');
        expect(field(/^Cron expression/)).toHaveProperty('value', '0 8 * * 1-5');
        await app.user.clear(field(/^Cron expression/));
        await app.user.type(field(/^Cron expression/), '*/30 8-17 * * 1-5');
        await app.user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Morning report' })).toBeDefined();

        await app.router.navigate({ to: '/triggers/$triggerId/edit', params: { triggerId: TRIGGER_IDS.weekday } });
        await waitFor(() => {
            expect(chosen('recurrence')).toBe('cron');
        });
        expect(field(/^Cron expression/)).toHaveProperty('value', '*/30 8-17 * * 1-5');
    });

    it('asks before Cancel throws away a change, and stays when asked to', async () => {
        const app = await renderForm(`/triggers/${TRIGGER_IDS.weekday}/edit`);
        await app.user.type(field(/^Name/), ' (draft)');
        await app.user.click(screen.getByRole('link', { name: 'Cancel' }));
        const dialog = await screen.findByRole('dialog', { name: m.unsaved_title() });
        await app.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(app.router.state.location.pathname).toBe(`/triggers/${TRIGGER_IDS.weekday}/edit`);
        expect(field(/^Name/)).toHaveProperty('value', 'Morning report (draft)');

        await app.user.click(screen.getByRole('link', { name: 'Cancel' }));
        await app.user.click(
            within(await screen.findByRole('dialog', { name: m.unsaved_title() })).getByRole('button', {
                name: m.unsaved_leave(),
            }),
        );
        await waitFor(() => {
            expect(app.router.state.location.pathname).toBe(`/triggers/${TRIGGER_IDS.weekday}`);
        });
        expect(app.engine.spies.update).not.toHaveBeenCalled();
    });

    it('leaves without asking when nothing changed, or a change was undone', async () => {
        const app = await renderForm(`/triggers/${TRIGGER_IDS.weekday}/edit`);
        await app.user.type(field(/^Name/), 'x');
        await app.user.type(field(/^Name/), '{Backspace}');
        // The breadcrumb to the trigger is the way back from its form.
        const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
        expect(within(trail).getByRole('link', { name: 'Triggers' }).getAttribute('href')).toBe('/triggers');
        await app.user.click(within(trail).getByRole('link', { name: 'Morning report' }));
        await waitFor(() => {
            expect(app.router.state.location.pathname).toBe(`/triggers/${TRIGGER_IDS.weekday}`);
        });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('without agents.read: no agent query, and the picker says why it is empty', async () => {
        const engine = createTriggersEngine({ permissions: PERMISSIONS.filter((each) => each !== 'agents.read') });
        const agentList = vi.spyOn(engine.client.agents, 'list');
        renderWithProviders({ path: '/triggers/new', engineApi: engine.client });
        await screen.findByRole('button', { name: 'Create trigger' });
        expect(field(/^Agent/)).toHaveProperty('disabled', true);
        expect(errorOf(field(/^Agent/))).toContain('Choosing an agent needs permission to see agents.');
        expect(agentList).not.toHaveBeenCalled();
    });

    // axe walks every Combobox, DateInput and field of the full form: ~4 s locally, ~26 s on a 2-core CI runner.
    it('has no axe violations', async () => {
        const { container } = await renderForm();
        await expectNoAxeViolations(container);
    }, 60_000);
});
