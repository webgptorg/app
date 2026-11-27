import { PERMISSIONS } from '@ptbk/engine-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createFakePopups } from '../../testing/fake-popups';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createSecurityEngine, documentText } from '../../testing/security-engine';
import { problemResponse } from '../../testing/test-engine-api';
import { STEP_UP_INTENT_KEY } from '../step-up/step-up-intent';
import { MAX_IMPORT_BYTES } from './password-import';

const CSV =
    'name,url,username,password\nWork,https://new.example/login,ada,import-password-canary\nOther,https://other.example,grace,unselected-canary';

/** jsdom File lacks Blob.text; real browsers supply it. */
function exportFile(text = CSV, name = 'test-export.csv'): File {
    const file = new File([text], name, { type: name.endsWith('.json') ? 'application/json' : 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(text), configurable: true });
    return file;
}

async function openImport() {
    await screen.findByRole('region', { name: 'Saved logins' });
    fireEvent.click(screen.getByRole('button', { name: 'Import logins' }));
    return screen.findByRole('dialog', { name: 'Import logins' });
}

describe('Wallet import', { timeout: 30_000 }, () => {
    it('previews selected logins, writes only the selection and never stores or renders passwords', async () => {
        const engine = createSecurityEngine();
        const add = vi.spyOn(engine.client.wallet, 'add');
        const app = renderWithProviders({ path: '/wallet', engineApi: engine.client });
        const dialog = await openImport();
        await app.user.upload(within(dialog).getByLabelText('Export file'), exportFile());
        const other = await within(dialog).findByRole('checkbox', { name: 'Other · grace' });
        await app.user.click(other);
        expect(documentText()).not.toContain('canary');
        await app.user.click(within(dialog).getByRole('button', { name: 'Import selected (1)' }));
        expect(await within(dialog).findByText('Import finished.')).toBeDefined();
        expect(add).toHaveBeenCalledTimes(1);
        expect(add.mock.calls[0]?.[0]).toEqual({
            origin: 'https://new.example',
            username: 'ada',
            password: 'import-password-canary',
            label: 'Work',
        });
        expect(documentText()).not.toContain('canary');
        expect(
            JSON.stringify(
                app.queryClient
                    .getQueryCache()
                    .getAll()
                    .map(({ state }) => state.data),
            ),
        ).not.toContain('canary');
        expect(
            JSON.stringify(
                app.queryClient
                    .getMutationCache()
                    .getAll()
                    .map(({ state }) => state.variables),
            ),
        ).not.toContain('canary');
    });

    it('leaves saved logins unselected, matching www and account case, until explicitly chosen', async () => {
        const engine = createSecurityEngine();
        await engine.client.wallet.add(
            { origin: 'https://www.new.example', username: 'ADA', password: 'old-canary' },
            AbortSignal.timeout(1000),
        );
        const add = vi.spyOn(engine.client.wallet, 'add');
        const { user } = renderWithProviders({ path: '/wallet', engineApi: engine.client });
        const dialog = await openImport();
        await user.upload(within(dialog).getByLabelText('Export file'), exportFile());
        const existing = await within(dialog).findByRole('checkbox', { name: 'Work · ada' });
        expect(existing).toHaveProperty('checked', false);
        expect(within(dialog).getByText(/Replaces a saved login/)).toBeDefined();
        await user.click(within(dialog).getByRole('checkbox', { name: 'Select all new logins' }));
        expect(existing).toHaveProperty('checked', false);
        await user.click(existing);
        await user.click(within(dialog).getByRole('button', { name: 'Import selected (1)' }));
        expect(await within(dialog).findByText('Import finished.')).toBeDefined();
        expect(add.mock.calls[0]?.[0].origin).toBe('https://new.example');
    });

    it('reports encrypted, malformed, oversized, unreadable and empty exports without echoing file contents', async () => {
        const { user } = renderWithProviders({ path: '/wallet', engineApi: createSecurityEngine().client });
        const dialog = await openImport();
        const fileInput = within(dialog).getByLabelText('Export file');
        await user.upload(fileInput, exportFile('{"encrypted":true,"data":"secret-canary"}', 'test.json'));
        expect(await within(dialog).findByText(/This export is encrypted/)).toBeDefined();
        await user.upload(fileInput, exportFile('url,username,password\n"secret-canary'));
        expect(await within(dialog).findByText(/This file is not a supported export/)).toBeDefined();
        const big = exportFile();
        Object.defineProperty(big, 'size', { value: MAX_IMPORT_BYTES + 1 });
        await user.upload(fileInput, big);
        expect(await within(dialog).findByText(/Choose a file smaller/)).toBeDefined();
        const broken = exportFile();
        Object.defineProperty(broken, 'text', {
            value: () => Promise.reject(new Error('secret-canary')),
            configurable: true,
        });
        await user.upload(fileInput, broken);
        expect(await within(dialog).findByText(/The file could not be read/)).toBeDefined();
        await user.upload(fileInput, exportFile('url,username,password\nandroidapp://example,ada,pw'));
        expect(await within(dialog).findByText('No supported website logins were found.')).toBeDefined();
        expect(within(dialog).getByText(/^Skipped 1 entries/)).toBeDefined();
        expect(documentText()).not.toContain('secret-canary');
    });

    it('stops at a permanent failure, keeps the first save and clears the unimported queue', async () => {
        const engine = createSecurityEngine();
        const original = engine.client.wallet.add.bind(engine.client.wallet);
        const add = vi
            .spyOn(engine.client.wallet, 'add')
            .mockImplementationOnce(original)
            .mockImplementationOnce(() => problemResponse('wallet-not-ready'));
        const { user } = renderWithProviders({ path: '/wallet', engineApi: engine.client });
        const dialog = await openImport();
        await user.upload(
            within(dialog).getByLabelText('Export file'),
            exportFile(CSV + '\nThird,https://third.example,alice,third-canary'),
        );
        await within(dialog).findByRole('checkbox', { name: 'Other · grace' });
        await user.click(within(dialog).getByRole('button', { name: 'Import selected (3)' }));
        expect(await within(dialog).findByText(/The remaining logins were not imported/)).toBeDefined();
        expect(within(dialog).getByText('Saved 1 of 3 selected logins.')).toBeDefined();
        expect(add).toHaveBeenCalledTimes(2);
        expect(documentText()).not.toContain('canary');
    });

    it('continues the same queue after a popup step-up without replaying the completed save', async () => {
        const engine = createSecurityEngine();
        const original = engine.client.wallet.add.bind(engine.client.wallet);
        const add = vi
            .spyOn(engine.client.wallet, 'add')
            .mockImplementationOnce(original)
            .mockImplementationOnce(() => problemResponse('step-up-required'));
        const popups = createFakePopups();
        const { user, storage } = renderWithProviders({ path: '/wallet', engineApi: engine.client, popups });
        const dialog = await openImport();
        await user.upload(within(dialog).getByLabelText('Export file'), exportFile());
        await within(dialog).findByRole('checkbox', { name: 'Other · grace' });
        await user.click(within(dialog).getByRole('button', { name: 'Import selected (2)' }));
        const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await user.click(within(stepUp).getByRole('button', { name: 'Continue with passkey' }));
        popups.confirm();
        expect(await within(dialog).findByText('Import finished.')).toBeDefined();
        expect(add.mock.calls.map(([body]) => body.origin)).toEqual([
            'https://new.example',
            'https://other.example',
            'https://other.example',
        ]);
        expect(storage.getItem(STEP_UP_INTENT_KEY)).toBeNull();
        expect(documentText()).not.toContain('canary');
    });

    it('requires a ready Wallet and permission to import', async () => {
        const engine = createSecurityEngine({
            permissions: PERMISSIONS.filter((permission) => permission !== 'wallet.manage'),
        });
        const first = renderWithProviders({ path: '/wallet', engineApi: engine.client });
        await screen.findByRole('region', { name: 'Saved logins' });
        expect(screen.queryByRole('button', { name: 'Import logins' })).toBeNull();
        first.unmount();
        const locked = createSecurityEngine();
        locked.controller.setWalletState('locked');
        renderWithProviders({ path: '/wallet', engineApi: locked.client });
        await screen.findByText(/The Wallet is locked on the server/);
        expect(screen.queryByRole('button', { name: 'Import logins' })).toBeNull();
    });

    it('drops the export during full-page step-up and asks for a fresh selection afterwards', async () => {
        const engine = createSecurityEngine();
        vi.spyOn(engine.client.wallet, 'add').mockImplementationOnce(() => problemResponse('step-up-required'));
        const app = renderWithProviders({
            path: '/wallet',
            engineApi: engine.client,
            popups: createFakePopups({ blocked: true }),
        });
        const dialog = await openImport();
        await app.user.upload(within(dialog).getByLabelText('Export file'), exportFile());
        await within(dialog).findByRole('checkbox', { name: 'Work · ada' });
        await app.user.click(within(dialog).getByRole('button', { name: 'Import selected (2)' }));
        const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await app.user.click(within(stepUp).getByRole('button', { name: 'Continue with passkey' }));
        expect(app.location.assign).toHaveBeenCalledOnce();
        expect(app.storage.getItem(STEP_UP_INTENT_KEY)).toBeNull();
        app.unmount();
        const returned = renderWithProviders({ path: '/wallet', engineApi: engine.client, storage: app.storage });
        const fresh = await openImport();
        expect(within(fresh).queryByRole('checkbox')).toBeNull();
        expect(documentText()).not.toContain('canary');
        expect(
            JSON.stringify(
                returned.queryClient
                    .getMutationCache()
                    .getAll()
                    .map(({ state }) => state.variables),
            ),
        ).not.toContain('canary');
    });

    it('does not save after closing the import during a file read', async () => {
        let finish: ((text: string) => void) | undefined;
        const file = exportFile();
        Object.defineProperty(file, 'text', {
            value: () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                }),
            configurable: true,
        });
        const engine = createSecurityEngine();
        const add = vi.spyOn(engine.client.wallet, 'add');
        const { user } = renderWithProviders({ path: '/wallet', engineApi: engine.client });
        const dialog = await openImport();
        await user.upload(within(dialog).getByLabelText('Export file'), file);
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        finish?.(CSV);
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: 'Import logins' })).toBeNull();
        });
        const reopened = await openImport();
        expect(within(reopened).queryByRole('checkbox')).toBeNull();
        expect(add).not.toHaveBeenCalled();
    });
});
