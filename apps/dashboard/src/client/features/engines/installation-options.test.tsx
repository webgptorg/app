import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { testInstallationOptions } from '../../../testing/install-fixtures';
import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { INSTALL_GUIDE_URL, LINK_URL, linkCodeView, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { ok } from '../../testing/scripted-api';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('structured installation choices', () => {
    it('defaults to a new project, switches OS/AI targets, copies exact payloads and preserves the EXE pairing step', async () => {
        const options = testInstallationOptions(LINK_URL);
        const app = renderApp({
            path: '/engines/new',
            session: session({ permissions: ['org.read', 'engine.link', 'engine.read'] }),
            script: (api) => {
                api.on(
                    apiRoutes.linkEligibility,
                    ok({ eligibility: 'allowed', linkCodeTtlS: 2_592_000, installGuideUrl: INSTALL_GUIDE_URL }),
                );
                api.on(apiRoutes.createLinkCode, ok(linkCodeView({ installationOptions: options })));
                api.on(apiRoutes.getLinkCode, ok({ status: 'pending', expiresAt: linkCodeView().expiresAt }));
            },
        });
        const list = await screen.findByRole('tablist', { name: 'How to install' });
        expect(
            within(list)
                .getAllByRole('tab')
                .map((tab) => tab.textContent),
        ).toEqual(['New project', 'Install with AI', 'Windows EXE']);
        expect(screen.getByRole('tab', { name: 'New project' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByText(/On macOS, open Terminal/)).toBeTruthy();
        expect(screen.getByText(/Paste the entire copied block/)).toBeTruthy();
        expect(screen.getByText(/The engine connects to this app first/)).toBeTruthy();
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        try {
            await app.user.click(screen.getByRole('tab', { name: 'Windows PowerShell' }));
            expect(screen.getByText(/Open PowerShell from the Windows Start menu/)).toBeTruthy();
            expect(screen.queryByText(/On macOS, open Terminal/)).toBeNull();
            await app.user.click(
                within(screen.getByRole('tabpanel', { name: 'Windows PowerShell' })).getByRole('button', {
                    name: 'Copy command',
                }),
            );
            expect(writeText).toHaveBeenLastCalledWith(
                options.find((option) => option.kind === 'command')?.commands.powershell,
            );
            await app.user.click(screen.getByRole('tab', { name: 'Ubuntu VPS' }));
            expect(screen.getByText(/Connect over SSH to the server/)).toBeTruthy();
            expect(screen.queryByText(/Open PowerShell from the Windows Start menu/)).toBeNull();
            await app.user.click(screen.getByRole('tab', { name: 'Install with AI' }));
            await app.user.click(await screen.findByRole('tab', { name: 'Existing VPS over SSH' }));
            await app.user.click(
                within(screen.getByRole('tabpanel', { name: 'Existing VPS over SSH' })).getByRole('button', {
                    name: 'Copy prompt',
                }),
            );
            expect(writeText).toHaveBeenLastCalledWith(
                options.find((option) => option.kind === 'ai')?.prompts.en.server,
            );
            await app.user.click(screen.getByRole('tab', { name: 'Windows EXE' }));
            const download = options.find((option) => option.kind === 'download');
            expect((await screen.findByRole('link', { name: /Download Windows EXE/ })).getAttribute('href')).toBe(
                download?.url,
            );
            await app.user.click(
                within(screen.getByRole('tabpanel', { name: 'Windows EXE' })).getByRole('button', {
                    name: 'Copy command',
                }),
            );
            expect(writeText).toHaveBeenLastCalledWith(download?.afterInstall);
            await waitFor(() => {
                expect(app.api.callsTo(apiRoutes.createLinkCode)).toHaveLength(1);
            });
            await expectNoAxeViolations(app.container);
        } finally {
            Reflect.deleteProperty(navigator, 'clipboard');
        }
    });
});
