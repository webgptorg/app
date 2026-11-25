import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { testInstallationOptions } from '../../../testing/install-fixtures';
import { apiRoutes } from '../../../shared/api/routes';
import { INSTALL_GUIDE_URL, LINK_URL, linkCodeView, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { ok } from '../../testing/scripted-api';

beforeEach(() => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['cs-CZ', 'cs']);
});
afterEach(() => {
    vi.restoreAllMocks();
});

it('copies the Czech paired AI prompt from its top-level tab', async () => {
    const options = testInstallationOptions(LINK_URL);
    const app = renderApp({
        path: '/engines/new',
        session: session({ locale: 'cs', permissions: ['org.read', 'engine.link', 'engine.read'] }),
        script: (api) => {
            api.on(
                apiRoutes.linkEligibility,
                ok({ eligibility: 'allowed', linkCodeTtlS: 2_592_000, installGuideUrl: INSTALL_GUIDE_URL }),
            );
            api.on(apiRoutes.createLinkCode, ok(linkCodeView({ installationOptions: options })));
            api.on(apiRoutes.getLinkCode, ok({ status: 'pending', expiresAt: linkCodeView().expiresAt }));
        },
    });
    await app.user.click(await screen.findByRole('tab', { name: 'Instalace pomocí AI' }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
        const panel = await screen.findByRole('tabpanel', { name: 'Instalace pomocí AI' });
        await app.user.click(within(panel).getByRole('button', { name: 'Kopírovat prompt' }));
        const prompt = options.find((option) => option.kind === 'ai')?.prompts.cs.local;
        expect(writeText).toHaveBeenLastCalledWith(prompt);
        expect(panel.querySelector('pre code')?.textContent).toBe(prompt);
        expect(screen.getByText(/Vyberte způsob instalace. Projekt se nejdřív připojí/)).toBeTruthy();
        expect(screen.getByRole('tab', { name: 'Již běžící projekt' })).toBeTruthy();
        expect(screen.getByText(/^Agenti pracují s oprávněními, soubory a přihlášenými službami/)).toBeTruthy();
        await app.user.click(screen.getByRole('tab', { name: 'Ubuntu VPS' }));
        expect(
            within(screen.getByRole('tabpanel', { name: 'Ubuntu VPS' })).getByText(
                'Ubuntu 24.04 x64 se systemd. Spusťte ho jako root nebo přes sudo.',
            ),
        ).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/engines_new_/);
    } finally {
        Reflect.deleteProperty(navigator, 'clipboard');
    }
});
