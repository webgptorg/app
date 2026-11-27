import { screen, within } from '@testing-library/react';
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
    it.each([
        ['Macintosh', 'macOS / Linux'],
        ['Windows NT 10.0', 'Windows PowerShell'],
    ])('offers the local installer for %s and allows a different target', async (userAgent, initialTab) => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
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
        expect(screen.getAllByRole('tablist')).toHaveLength(1);
        expect(within(list).getByRole('tab', { name: initialTab, selected: true })).toBeTruthy();
        expect(screen.getByText(/Choose an installation method/)).toBeTruthy();
        expect(within(screen.getByRole('tabpanel')).queryByRole('list')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Copy address' })).toBeNull();
        expect(
            screen.getByText(/^Agents use this computer’s permissions, files and signed-in services\./),
        ).toBeTruthy();

        const commands = options.find((option) => option.kind === 'command')?.commands;
        const prompts = options.find((option) => option.kind === 'ai')?.prompts.en;
        const download = options.find((option) => option.kind === 'download');
        const paths = linkCodeView().installCommands;
        const choices = [
            ['macOS / Linux', 'Copy command', commands?.posix],
            ['Windows PowerShell', 'Copy command', commands?.powershell],
            ['Ubuntu VPS', 'Copy command', commands?.ubuntu],
            ['Install with AI', 'Copy prompt', prompts?.local],
            ['Windows EXE', 'Copy command', download?.afterInstall],
            ['Docker Compose', 'Copy command', paths.find((path) => path.id === 'compose')?.command],
            ['Running project', 'Copy command', paths.find((path) => path.id === 'connect')?.command],
            ['AI over SSH', 'Copy prompt', prompts?.server],
        ] as const;
        expect(
            within(list)
                .getAllByRole('tab')
                .map((tab) => tab.textContent),
        ).toEqual(choices.map(([name]) => name));

        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        try {
            for (const [name, button, value] of choices) {
                await app.user.click(within(list).getByRole('tab', { name }));
                const tabPanel = screen.getByRole('tabpanel', { name });
                const panel = within(tabPanel);
                await app.user.click(await panel.findByRole('button', { name: button }));
                expect(writeText).toHaveBeenLastCalledWith(value);
                expect(tabPanel.querySelector('pre code')?.textContent).toBe(value);
                expect(panel.queryByRole('tablist')).toBeNull();
                expect(panel.queryByText('Ubuntu 24.04 x64 with systemd. Run it as root or with sudo.') !== null).toBe(
                    name === 'Ubuntu VPS',
                );
                if (name === 'Windows EXE') {
                    expect(panel.getByRole('link', { name: /Download Windows EXE/ }).getAttribute('href')).toBe(
                        download?.url,
                    );
                    await app.user.click(panel.getByText('Installer SHA-256'));
                    expect(panel.getByText(download?.sha256 ?? '')).toBeTruthy();
                }
                if (name === 'Running project') {
                    await app.user.click(panel.getByRole('button', { name: 'Copy address' }));
                    expect(writeText).toHaveBeenLastCalledWith(LINK_URL);
                }
            }
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toHaveLength(1);
            await expectNoAxeViolations(app.container);
        } finally {
            Reflect.deleteProperty(navigator, 'clipboard');
        }
    });
});
