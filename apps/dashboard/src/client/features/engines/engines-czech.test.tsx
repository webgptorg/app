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
            path: '/engines/all',
            session: OWNER,
            script: (api) => {
                api.on(apiRoutes.listEngines, ok({ engines: [engineView({ reachableRelays: 2 })] }));
                api.on(apiRoutes.getEngine, ok({ engine: engineView({ reachableRelays: 0 }) }));
            },
        });
        expect(await screen.findByRole('heading', { name: 'Vaše projekty' })).toBeTruthy();
        expect(await screen.findByText('Online')).toBeTruthy();
        const table = screen.getByRole('table', { name: 'Projekty této organizace' });
        for (const header of ['Projekt', 'Stav', 'Adresa', 'Verze']) {
            expect(within(table).getByRole('columnheader', { name: header })).toBeTruthy();
        }
        expect(within(table).getByText('Je k dispozici aktualizace')).toBeTruthy();
        expect(within(table).getByText('Dostupný přes 2 relaye')).toBeTruthy();
        expect(
            within(table).getByRole('link', { name: `Otevřít projekt ${ENGINE_ID.slice(0, 8)}… v nové kartě` }),
        ).toBeTruthy();

        await app.user.click(screen.getByRole('link', { name: `${ENGINE_ID.slice(0, 8)}…` }));
        expect(await screen.findByRole('heading', { name: 'Poslední signál' })).toBeTruthy();
        expect(screen.getByText(/Přihlašovací a bezpečnostní stránka projektu/)).toBeTruthy();
        expect(screen.getByText('Přes relaye Promptbooku')).toBeTruthy();
        expect(screen.getByText('Nedostupný: žádné spojení s relayem')).toBeTruthy();

        await app.user.click(screen.getByRole('button', { name: `Akce pro projekt ${ENGINE_ID.slice(0, 8)}…` }));
        await app.user.click(screen.getByRole('menuitem', { name: 'Odvolat projekt' }));
        const dialog = await screen.findByRole('dialog', { name: `Odvolat projekt ${ENGINE_ID.slice(0, 8)}…?` });
        expect(within(dialog).getByText(/Dostane nové ID i adresu/)).toBeTruthy();
        expect(within(dialog).getByRole('button', { name: 'Odvolat přístupovým klíčem' })).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/engines_|engine_[a-z]/);
    });

    it('says in Czech that the setup is not finished, on the list and the engine page', async () => {
        const base = engineView();
        const pending = engineView({
            status: 'setup-pending',
            heartbeat: base.heartbeat === null ? null : { ...base.heartbeat, setup: 'pending' },
        });
        const app = renderApp({
            path: '/engines/all',
            session: OWNER,
            script: (api) => {
                api.on(apiRoutes.listEngines, ok({ engines: [pending] }));
                api.on(apiRoutes.getEngine, ok({ engine: pending }));
            },
        });
        expect(await screen.findByText('Nastavení není dokončené')).toBeTruthy();
        expect(
            screen.getByRole('link', {
                name: `Pokračovat v nastavení projektu ${ENGINE_ID.slice(0, 8)}… v nové kartě`,
            }),
        ).toBeTruthy();

        await app.user.click(screen.getByRole('link', { name: `${ENGINE_ID.slice(0, 8)}…` }));
        expect(await screen.findByText('Nastavení pokračuje na projektu tam, kde jste skončili.')).toBeTruthy();
        await app.user.click(screen.getByText('Co projekt nahlásil'));
        expect(screen.getByText('Nastavení', { selector: 'dt' }).nextElementSibling?.textContent).toBe('Nedokončené');
        expect(document.body.textContent).not.toMatch(/engines_|engine_[a-z]/);
    });

    it('offers the install tabs without missing texts', async () => {
        const app = renderApp({
            path: '/engines/new',
            session: OWNER,
            script: (api) => {
                const view = linkCodeView();
                api.on(
                    apiRoutes.linkEligibility,
                    ok({ eligibility: 'allowed', linkCodeTtlS: 2_592_000, installGuideUrl: view.installGuideUrl }),
                );
                api.on(apiRoutes.createLinkCode, ok(view));
                api.on(apiRoutes.getLinkCode, ok({ status: 'pending', expiresAt: view.expiresAt }));
            },
        });
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
                    name: 'Kopírovat příkaz',
                }),
            ).toBeTruthy();
            expect(document.body.textContent).not.toMatch(/engines_/);
        }
        expect(screen.getByRole('link', { name: /^Přesun existujícího nasazení/ })).toBeTruthy();
    });

    it('explains an offline engine in Czech', async () => {
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: OWNER,
            script: (api) => {
                api.on(apiRoutes.getEngine, ok({ engine: engineView({ status: 'offline' }) }));
                api.on(apiRoutes.getInstallGuide, ok({ url: 'https://docs.ptbk.test/engine/installation' }));
            },
        });
        expect(await screen.findByText('Projekt se neozývá')).toBeTruthy();
        expect(screen.getByText('Pokud jeho server běží, spusťte na něm ve složce projektu:')).toBeTruthy();
        expect(await screen.findByRole('link', { name: /Řešení potíží v návodu k instalaci/ })).toBeTruthy();
    });
});
