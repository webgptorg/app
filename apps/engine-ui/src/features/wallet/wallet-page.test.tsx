import { PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createMemoryStorage } from '../../testing/memory-storage';
import { createSecurityEngine, documentText } from '../../testing/security-engine';
import type { SecurityEngine } from '../../testing/security-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 30_000;
/** The dialog is a lazy chunk; on a loaded runner it takes longer than the default second. */
const DIALOG_WAIT = { timeout: 5_000 };
const AT = '2026-09-30T10:00:00Z';

function walletEngine(permissions?: readonly Permission[], stepUp?: 'required'): SecurityEngine {
    const engine = createSecurityEngine({
        ...(permissions === undefined ? {} : { permissions }),
        ...(stepUp === undefined ? {} : { stepUp }),
        seed: {
            wallet: {
                records: [
                    {
                        id: 'login-github',
                        label: 'github.com · ad…@example.com',
                        origin: 'https://github.com',
                        username: 'ada@example.com',
                        fields: [{ label: 'Recovery phone', uncertain: false }],
                        updatedAt: AT,
                        lastUse: { at: AT, outcome: 'signed-in' },
                        verification: { state: 'verified', at: AT, reason: 'Signed in as ada.' },
                    },
                ],
            },
        },
    });
    engine.controller.requestWalletLogin({
        origin: 'https://linear.app',
        account: 'ada@example.com',
        problem: 'missing',
        fields: [],
        recordId: null,
        reason: 'Ada needs Linear to file the findings.',
        tasks: ['File the review findings'],
        agents: ['Ada'],
    });
    return engine;
}

describe('Wallet', { timeout: TIMEOUT_MS }, () => {
    it('lists logins without secrets, then what agents wait for', async () => {
        renderWithProviders({ path: '/wallet', engineApi: walletEngine().client });
        const logins = await screen.findByRole('region', { name: 'Saved logins' });
        expect(within(logins).getByText('github.com · ad…@example.com')).toBeDefined();
        expect(within(logins).getByText('Verified')).toBeDefined();
        expect(within(logins).getByText(/ada@example\.com · also Recovery phone/)).toBeDefined();
        const requests = screen.getByRole('region', { name: 'Agents are waiting' });
        expect(within(requests).getByText('Ada needs a login for linear.app')).toBeDefined();
        expect(within(requests).getByText('For: File the review findings')).toBeDefined();
    });

    it('answers a request with a masked password the owner may reveal, which never comes back', async () => {
        const engine = walletEngine();
        const { user } = renderWithProviders({ path: '/wallet', engineApi: engine.client });
        const requests = await screen.findByRole('region', { name: 'Agents are waiting' });
        await user.click(within(requests).getByRole('button', { name: 'Add login' }));
        const dialog = await screen.findByRole('dialog', { name: 'Add login' }, DIALOG_WAIT);
        expect(within(dialog).getByRole('textbox', { name: /^Website/ })).toHaveProperty('value', 'https://linear.app');
        expect(within(dialog).getByRole('textbox', { name: /^Username or email/ })).toHaveProperty(
            'value',
            'ada@example.com',
        );
        const password = within(dialog).getByLabelText(/^Password/);
        expect(password.getAttribute('type')).toBe('password');
        await user.type(password, 'wallet-canary-password');
        await user.click(within(dialog).getByRole('button', { name: 'Show' }));
        expect(password.getAttribute('type')).toBe('text');
        expect(within(dialog).getByRole('button', { name: 'Hide' }).getAttribute('aria-pressed')).toBe('true');
        await user.click(within(dialog).getByRole('button', { name: 'Save login' }));

        expect(await screen.findByText('Login for linear.app saved. The waiting work continues.')).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByRole('region', { name: 'Agents are waiting' })).toBeNull();
        });
        expect(await screen.findByText('linear.app · ad…@example.com')).toBeDefined();
        expect(documentText()).not.toContain('wallet-canary-password');
    });

    it('marks a request as seen and keeps it waiting, and rejects one from the menu', async () => {
        const engine = walletEngine();
        const { user } = renderWithProviders({ path: '/wallet', engineApi: engine.client });
        const requests = await screen.findByRole('region', { name: 'Agents are waiting' });
        await user.click(within(requests).getByRole('button', { name: 'Mark as seen' }));
        expect(await within(requests).findByText('Seen')).toBeDefined();
        expect(within(requests).queryByRole('button', { name: 'Mark as seen' })).toBeNull();

        await user.click(within(requests).getByRole('button', { name: 'More for the linear.app request' }));
        await user.click(await screen.findByRole('menuitem', { name: /^Reject request/ }));
        expect(await screen.findByText('Request for linear.app rejected.')).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByRole('region', { name: 'Agents are waiting' })).toBeNull();
        });
    });

    it('shows one plain line when the Wallet is not set up, and offers no login form', async () => {
        const engine = walletEngine();
        engine.controller.setWalletState('empty');
        renderWithProviders({ path: '/wallet?dialog=new', engineApi: engine.client });
        expect(
            await screen.findByText("The Wallet isn't set up yet. It's set up on the server, not here."),
        ).toBeDefined();
        expect(screen.queryByRole('region', { name: 'Saved logins' })).toBeNull();
        expect(screen.queryByRole('dialog', { name: 'Add login' })).toBeNull();
        const requests = screen.getByRole('region', { name: 'Agents are waiting' });
        expect(within(requests).queryByRole('button', { name: 'Add login' })).toBeNull();
        expect(within(requests).getByRole('button', { name: 'Mark as seen' })).toBeDefined();
    });

    it('lets wallet.read look but change nothing', async () => {
        const reader = PERMISSIONS.filter((permission) => permission !== 'wallet.manage');
        renderWithProviders({ path: '/wallet', engineApi: walletEngine(reader).client });
        await screen.findByRole('region', { name: 'Saved logins' });
        expect(screen.queryByRole('button', { name: 'Add login' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Mark as seen' })).toBeNull();
    });

    it('shows each verification state, a locked or unavailable Wallet, and requests answered on the server', async () => {
        const engine = createSecurityEngine({
            seed: {
                wallet: {
                    records: [
                        {
                            id: 'login-a',
                            label: 'Refused one',
                            origin: 'https://a.example',
                            username: null,
                            fields: [],
                            updatedAt: AT,
                            lastUse: null,
                            verification: { state: 'rejected', at: AT, reason: 'The website refused the password.' },
                        },
                        {
                            id: 'login-b',
                            label: 'Half checked',
                            origin: 'https://b.example',
                            username: 'b',
                            fields: [],
                            updatedAt: AT,
                            lastUse: null,
                            verification: { state: 'incomplete', at: AT, reason: 'A code was needed.' },
                        },
                        {
                            id: 'login-c',
                            label: 'Never checked',
                            origin: 'https://c.example',
                            username: 'c',
                            fields: [],
                            updatedAt: AT,
                            lastUse: null,
                            verification: null,
                        },
                    ],
                },
            },
        });
        for (const problem of ['code', 'locked'] as const) {
            engine.controller.requestWalletLogin({
                origin: `https://${problem}.example`,
                account: null,
                problem,
                fields: [],
                recordId: null,
                reason: 'r',
                tasks: [],
                agents: [],
            });
        }
        renderWithProviders({ path: '/wallet', engineApi: engine.client });
        const logins = await screen.findByRole('region', { name: 'Saved logins' });
        expect(within(logins).getByText('Refused')).toBeDefined();
        expect(within(logins).getByText('The website refused the password.')).toBeDefined();
        expect(within(logins).getByText('Not checked fully')).toBeDefined();
        expect(within(logins).getByText('Not checked yet')).toBeDefined();
        expect(within(logins).getAllByText('Not used yet')).toHaveLength(3);
        const requests = screen.getByRole('region', { name: 'Agents are waiting' });
        expect(within(requests).getByText('Fixer needs a one-time code for code.example')).toBeDefined();
        expect(
            within(requests).getByText('Fixer needs the Wallet unlocked to sign in to locked.example'),
        ).toBeDefined();
        expect(within(requests).getAllByText('This is answered on the server.')).toHaveLength(2);
        expect(within(requests).queryByRole('button', { name: 'Add login' })).toBeNull();
    });

    it.each([
        ['locked', 'The Wallet is locked on the server and is unlocked there. Its 4 saved logins are kept.'],
        ['unavailable', "The Wallet can't be used on this server right now. That is fixed on the server."],
    ] as const)('says in one line that a %s Wallet is handled on the server', async (state, line) => {
        const engine = walletEngine();
        engine.controller.setWalletState(state, 4);
        renderWithProviders({ path: '/wallet', engineApi: engine.client });
        expect(await screen.findByText(line)).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Add login' })).toBeNull();
    });

    it('updates a saved login with a new password and name, and removes one after asking', async () => {
        const engine = walletEngine();
        const { user } = renderWithProviders({ path: '/wallet', engineApi: engine.client });
        const logins = await screen.findByRole('region', { name: 'Saved logins' });
        await user.click(within(logins).getByRole('button', { name: 'Update' }));
        const dialog = await screen.findByRole('dialog', { name: 'Update login for github.com' }, DIALOG_WAIT);
        expect(within(dialog).getByRole('textbox', { name: /^Website/ })).toHaveProperty('readOnly', true);
        await user.click(within(dialog).getByRole('button', { name: 'Save login' }));
        expect(await within(dialog).findByText('Enter the password.')).toBeDefined();
        await user.type(within(dialog).getByLabelText(/^Password/), 'new-password');
        const name = within(dialog).getByRole('textbox', { name: /^Name/ });
        await user.clear(name);
        await user.type(name, 'Work GitHub');
        await user.click(within(dialog).getByRole('button', { name: 'Save login' }));
        expect(await screen.findByText('Login for github.com saved.')).toBeDefined();
        expect(await within(logins).findByText('Work GitHub')).toBeDefined();

        await user.click(within(logins).getByRole('button', { name: 'More for Work GitHub' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Remove login' }));
        const confirm = await screen.findByRole('dialog', { name: 'Remove Work GitHub?' });
        await user.click(within(confirm).getByRole('button', { name: 'Remove login' }));
        expect(await screen.findByText('Work GitHub removed.')).toBeDefined();
    });

    it('asks for the fields a website wants, masked, and reports a Wallet that stopped being ready', async () => {
        const engine = walletEngine();
        engine.controller.requestWalletLogin({
            origin: 'https://bank.example',
            account: 'ada',
            problem: 'field',
            fields: ['Date of birth'],
            recordId: null,
            reason: 'r',
            tasks: [],
            agents: ['Ada'],
        });
        const { user } = renderWithProviders({ path: '/wallet', engineApi: engine.client });
        const requests = await screen.findByRole('region', { name: 'Agents are waiting' });
        const row = within(requests).getByText('Ada needs more sign-in details for bank.example').closest('li');
        await user.click(within(row as HTMLElement).getByRole('button', { name: 'Add login' }));
        const dialog = await screen.findByRole('dialog', { name: 'Add login' }, DIALOG_WAIT);
        const field = within(dialog).getByLabelText(/^Date of birth/);
        expect(field.getAttribute('type')).toBe('password');
        await user.type(within(dialog).getByLabelText(/^Password/), 'pw');
        await user.click(within(dialog).getByRole('button', { name: 'Save login' }));
        expect(await within(dialog).findByText('Enter this detail.')).toBeDefined();

        engine.controller.setWalletState('locked');
        await user.type(within(dialog).getByLabelText(/^Password/), 'pw');
        await user.type(field, '1990-01-01');
        await user.click(within(dialog).getByRole('button', { name: 'Save login' }));
        expect(await screen.findByText("The Wallet isn't ready on the server, so nothing was saved.")).toBeDefined();
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: 'Add login' })).toBeNull();
        });
    });

    it('tells the member when a request moved on before they answered it', async () => {
        const engine = walletEngine();
        const { user } = renderWithProviders({ path: '/wallet', engineApi: engine.client });
        const requests = await screen.findByRole('region', { name: 'Agents are waiting' });
        engine.controller.requestWalletLogin({
            origin: 'https://linear.app',
            account: 'ada@example.com',
            problem: 'rejected',
            fields: [],
            recordId: null,
            reason: 'r',
            tasks: [],
            agents: ['Ada'],
        });
        await user.click(within(requests).getByRole('button', { name: 'Mark as seen' }));
        expect(await screen.findByText('The request changed in the meantime. Look at it again.')).toBeDefined();
    });

    it('asks for attention on the home page while a request is unseen', async () => {
        renderWithProviders({ path: '/', engineApi: walletEngine().client });
        expect(await screen.findByText('1 login request waiting')).toBeDefined();
    });

    it('asks for a passkey to save, and reopens the form without the password on return', async () => {
        const storage = createMemoryStorage();
        const engine = walletEngine(undefined, 'required');
        const first = renderWithProviders({ path: '/wallet', engineApi: engine.client, storage });
        const requests = await screen.findByRole('region', { name: 'Agents are waiting' });
        await first.user.click(within(requests).getByRole('button', { name: 'Add login' }));
        const form = await screen.findByRole('dialog', { name: 'Add login' }, DIALOG_WAIT);
        await first.user.type(within(form).getByLabelText(/^Password/), 'step-up-canary');
        await first.user.click(within(form).getByRole('button', { name: 'Save login' }));
        const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await first.user.click(within(stepUp).getByRole('button', { name: 'Continue with passkey' }));
        expect(first.location.assign).toHaveBeenCalledOnce();
        first.unmount();

        renderWithProviders({ path: '/wallet', engineApi: engine.client, storage });
        const resumed = await screen.findByRole('dialog', { name: 'Add login' }, DIALOG_WAIT);
        expect(within(resumed).getByText(/Type the password again/)).toBeDefined();
        expect(within(resumed).getByRole('textbox', { name: /^Website/ })).toHaveProperty(
            'value',
            'https://linear.app',
        );
        expect(within(resumed).getByRole('textbox', { name: /^Username or email/ })).toHaveProperty(
            'value',
            'ada@example.com',
        );
        expect(within(resumed).getByLabelText(/^Password/)).toHaveProperty('value', '');
    });

    it('asks for a passkey to remove a login, and asks again on return', async () => {
        const storage = createMemoryStorage();
        const engine = walletEngine(undefined, 'required');
        const first = renderWithProviders({ path: '/wallet', engineApi: engine.client, storage });
        const logins = await screen.findByRole('region', { name: 'Saved logins' });
        await first.user.click(within(logins).getByRole('button', { name: /^More for github\.com/ }));
        await first.user.click(await screen.findByRole('menuitem', { name: 'Remove login' }));
        const confirm = await screen.findByRole('dialog', { name: /^Remove github\.com/ });
        await first.user.click(within(confirm).getByRole('button', { name: 'Remove login' }));
        const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await first.user.click(within(stepUp).getByRole('button', { name: 'Continue with passkey' }));
        first.unmount();

        renderWithProviders({ path: '/wallet', engineApi: engine.client, storage });
        expect(await screen.findByRole('dialog', { name: /^Remove github\.com/ })).toBeDefined();
        const wallet = await engine.client.wallet.get(AbortSignal.timeout(1000));
        expect(wallet.kind === 'ok' && wallet.data.records).toHaveLength(1);
    });

    it('validates a new login from the header before sending anything', async () => {
        const engine = walletEngine();
        const add = vi.spyOn(engine.client.wallet, 'add');
        const { user } = renderWithProviders({ path: '/wallet', engineApi: engine.client });
        await screen.findByRole('region', { name: 'Saved logins' });
        await user.click(screen.getAllByRole('button', { name: 'Add login' })[0] as HTMLElement);
        const dialog = await screen.findByRole('dialog', { name: 'Add login' }, DIALOG_WAIT);
        await user.type(within(dialog).getByRole('textbox', { name: /^Website/ }), 'not a site');
        await user.click(within(dialog).getByRole('button', { name: 'Save login' }));
        expect(await within(dialog).findByText('Enter a website address, such as github.com.')).toBeDefined();
        expect(within(dialog).getByText('Enter the username or email.')).toBeDefined();
        expect(within(dialog).getByText('Enter the password.')).toBeDefined();
        expect(add).not.toHaveBeenCalled();
    });

    it('offers a retry when the Wallet cannot be loaded, and reports refused changes', async () => {
        const engine = walletEngine();
        const get = vi.spyOn(engine.client.wallet, 'get').mockImplementation(() => problemResponse('internal-error'));
        vi.spyOn(engine.client.wallet, 'delete').mockImplementation(() => problemResponse('internal-error'));
        vi.spyOn(engine.client.wallet, 'reject').mockImplementation(() => problemResponse('internal-error'));
        const { user } = renderWithProviders({ path: '/wallet', engineApi: engine.client });
        expect(await screen.findByText('The Wallet could not be loaded.', {}, { timeout: 10_000 })).toBeDefined();
        get.mockRestore();
        await user.click(screen.getByRole('button', { name: /^(Try again|Retry)/ }));
        const logins = await screen.findByRole('region', { name: 'Saved logins' });

        await user.click(within(logins).getByRole('button', { name: /^More for github\.com/ }));
        await user.click(await screen.findByRole('menuitem', { name: 'Remove login' }));
        const confirm = await screen.findByRole('dialog', { name: /^Remove github\.com/ });
        await user.click(within(confirm).getByRole('button', { name: 'Remove login' }));
        expect(await screen.findByText('github.com · ad…@example.com could not be removed.')).toBeDefined();
        await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));

        const requests = screen.getByRole('region', { name: 'Agents are waiting' });
        await user.click(within(requests).getByRole('button', { name: 'More for the linear.app request' }));
        await user.click(await screen.findByRole('menuitem', { name: /^Reject request/ }));
        expect(await screen.findByText('The request for linear.app could not be rejected.')).toBeDefined();
    });
});
