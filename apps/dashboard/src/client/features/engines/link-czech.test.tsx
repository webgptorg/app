import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRoutes, type EngineView } from '../../../shared/api/routes';
import { billingView, ENGINE_DOMAIN, ENGINE_ID, engineView, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { ok } from '../../testing/scripted-api';

const OWNER = session({
    locale: 'cs',
    permissions: ['org.read', 'billing.read', 'billing.manage', 'engine.link', 'engine.read'],
});
const LINK_ID = 'lllllllllllllllllllllllllq';

// Paraglide resolves the first locale once per page load, so the Czech scenario lives in its own test file.
describe('the link page in Czech', () => {
    beforeEach(() => {
        vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['cs-CZ', 'cs', 'en']);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the plan step and the checklist without missing texts', async () => {
        const [standard] = billingView().plans;
        if (standard === undefined) throw new Error('a plan');
        const ready = engineView({ reachableRelays: 2 });
        renderApp({
            path: `/engines/new?link=${LINK_ID}`,
            session: OWNER,
            script: (api) => {
                api.on(
                    apiRoutes.linkEligibility,
                    ok({
                        eligibility: 'allowed',
                        linkCodeTtlS: 2_592_000,
                        installGuideUrl: 'https://docs.ptbk.test/engine/installation',
                    }),
                );
                api.on(
                    apiRoutes.getLinkCode,
                    ok({
                        status: 'linked',
                        engineId: ENGINE_ID as EngineView['engineId'],
                        hostname: `${ENGINE_ID}.${ENGINE_DOMAIN}` as EngineView['hostname'],
                    }),
                );
                api.on(apiRoutes.getEngine, ok({ engine: ready }));
            },
        });
        expect(await screen.findByText('Váš projekt je připravený', { selector: 'h2' })).toBeTruthy();
        expect(screen.getByText('Dokončení na projektu')).toBeTruthy();
        expect(screen.getByText('Projekt je online, verze 1.4.2.')).toBeTruthy();
        expect(screen.getByText('Dostupný přes 2 relaye')).toBeTruthy();
        expect(
            screen.getByRole('link', { name: `Otevřít projekt ${ENGINE_ID.slice(0, 8)}… v nové kartě` }),
        ).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/engines_|link_progress_|billing_/);
    });

    it('ends on continuing the setup in Czech when the engine reports it unfinished', async () => {
        const base = engineView();
        renderApp({
            path: `/engines/new?link=${LINK_ID}`,
            session: OWNER,
            script: (api) => {
                api.on(
                    apiRoutes.linkEligibility,
                    ok({
                        eligibility: 'allowed',
                        linkCodeTtlS: 2_592_000,
                        installGuideUrl: 'https://docs.ptbk.test/engine/installation',
                    }),
                );
                api.on(
                    apiRoutes.getLinkCode,
                    ok({
                        status: 'linked',
                        engineId: ENGINE_ID as EngineView['engineId'],
                        hostname: `${ENGINE_ID}.${ENGINE_DOMAIN}` as EngineView['hostname'],
                    }),
                );
                api.on(
                    apiRoutes.getEngine,
                    ok({
                        engine: engineView({
                            status: 'setup-pending',
                            heartbeat: base.heartbeat === null ? null : { ...base.heartbeat, setup: 'pending' },
                        }),
                    }),
                );
            },
        });
        expect(await screen.findByText('Váš projekt je připojený', { selector: 'h2' })).toBeTruthy();
        expect(screen.getByText(/Dokončete jeho nastavení na projektu/)).toBeTruthy();
        expect(
            screen.getByRole('link', {
                name: `Pokračovat v nastavení projektu ${ENGINE_ID.slice(0, 8)}… v nové kartě`,
            }),
        ).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/engines_|link_progress_|billing_/);
    });

    it('names the trial and the code lifetime in Czech', async () => {
        const [standard] = billingView().plans;
        if (standard === undefined) throw new Error('a plan');
        renderApp({
            path: '/engines/new',
            session: OWNER,
            script: (api) => {
                api.on(
                    apiRoutes.linkEligibility,
                    ok({
                        eligibility: 'not-entitled',
                        linkCodeTtlS: 30,
                        installGuideUrl: 'https://docs.ptbk.test/engine/installation',
                    }),
                );
                api.on(apiRoutes.getBilling, ok(billingView({ plans: [{ ...standard, trialDays: 14 }] })));
            },
        });
        expect(await screen.findByRole('heading', { name: 'Vyberte si tarif a připojte projekt' })).toBeTruthy();
        expect(
            await screen.findByRole('button', { name: 'Začít 14denní zkušební období tarifu Standard' }),
        ).toBeTruthy();
        expect(screen.getByText('Tarif').closest('li')?.getAttribute('aria-current')).toBe('step');
        expect(document.body.textContent).not.toMatch(/engines_|link_progress_|billing_/);
    });
});
