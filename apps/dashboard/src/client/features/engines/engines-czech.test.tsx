import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { ENGINE_ID, engineView, linkCodeView, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { ok } from '../../testing/scripted-api';

const OWNER = session({ locale: 'cs', permissions: ['org.read', 'engine.read', 'engine.link', 'engine.revoke'] });

// Paraglide resolves the first locale once per page load, so the Czech scenario lives in its own test file.
describe('engines in Czech', () => {
    beforeEach(() => {
        vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['cs-CZ', 'cs', 'en']);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the list, the engine page and the revoke dialog without missing texts', async () => {
        const app = renderApp({
            path: '/engines',
            session: OWNER,
            script: (api) => {
                api.on(apiRoutes.listEngines, ok({ engines: [engineView({ reachableRelays: 2 })] }));
                api.on(apiRoutes.getEngine, ok({ engine: engineView({ reachableRelays: 0 }) }));
            },
        });
        expect(await screen.findByRole('heading', { name: 'Vaše enginy' })).toBeTruthy();
        expect(await screen.findByText('Online')).toBeTruthy();
        const table = screen.getByRole('table', { name: 'Enginy této organizace' });
        for (const header of ['Stav', 'Otisk', 'Adresa', 'Naposledy viděn', 'Aktualizace', 'Členové']) {
            expect(within(table).getByRole('columnheader', { name: header })).toBeTruthy();
        }
        expect(within(table).getByText('Je k dispozici aktualizace')).toBeTruthy();
        expect(within(table).getByText('Dostupný přes 2 relaye')).toBeTruthy();
        expect(
            within(table).getByRole('link', { name: `Otevřít engine ${ENGINE_ID.slice(0, 8)} v nové kartě` }),
        ).toBeTruthy();

        await app.user.click(screen.getByRole('link', { name: `${ENGINE_ID.slice(0, 8)}…` }));
        expect(await screen.findByRole('heading', { name: 'Poslední signál' })).toBeTruthy();
        expect(screen.getByText(/Bezpečnostní stránka samotného enginu/)).toBeTruthy();
        expect(screen.getByText('Přes relaye Promptbooku')).toBeTruthy();
        expect(screen.getByText('Dostupnost')).toBeTruthy();
        expect(screen.getByText('Nedostupný: žádné spojení s relayem')).toBeTruthy();

        await app.user.click(screen.getByRole('button', { name: 'Odvolat engine' }));
        const dialog = await screen.findByRole('dialog', { name: `Odvolat engine ${ENGINE_ID.slice(0, 8)}?` });
        expect(within(dialog).getByText(/nové ID enginu a novou adresu/)).toBeTruthy();
        expect(within(dialog).getByRole('button', { name: 'Trvale odvolat' })).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/engines_|engine_[a-z]/);
    });

    it('offers the install tabs without missing texts', async () => {
        const app = renderApp({
            path: '/engines/new',
            session: OWNER,
            script: (api) => api.on(apiRoutes.createLinkCode, ok(linkCodeView())),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Vytvořit připojovací kód' }));
        const list = await screen.findByRole('tablist', { name: 'Způsob instalace' });
        expect(
            within(list)
                .getAllByRole('tab')
                .map((tab) => tab.textContent),
        ).toEqual(['Linuxový server s Dockerem', 'Docker Compose', 'Promptbook už mám spuštěný']);
        expect(screen.getByRole('link', { name: /^Požadavky a proxy/ })).toBeTruthy();
        for (const name of ['Docker Compose', 'Promptbook už mám spuštěný']) {
            await app.user.click(within(list).getByRole('tab', { name }));
            expect(
                within(screen.getByRole('tabpanel', { name })).getByRole('button', {
                    name: 'Kopírovat instalační příkaz',
                }),
            ).toBeTruthy();
            expect(document.body.textContent).not.toMatch(/engines_/);
        }
        expect(screen.getByRole('link', { name: /^Přesun existujícího nasazení/ })).toBeTruthy();
    });
});
