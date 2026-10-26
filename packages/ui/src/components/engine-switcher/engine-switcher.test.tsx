import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { SAMPLE_FINGERPRINTS } from '../trust-mark/sample-fingerprints';
import { EngineSwitcher } from './engine-switcher';
import type { EngineSwitcherProps } from './engine-switcher';

const CURRENT = { name: 'Acme engine', fingerprint: SAMPLE_FINGERPRINTS.local, hostname: 'acme.engine.test' };

const ENGINE_UI: EngineSwitcherProps = {
    current: CURRENT,
    engines: [],
    allEnginesHref: 'https://app.ptbk.test',
    addEngineHref: 'https://app.ptbk.test/engines/new',
};

const DASHBOARD: EngineSwitcherProps = {
    ...ENGINE_UI,
    engines: [
        {
            name: 'Lab',
            fingerprint: SAMPLE_FINGERPRINTS.lead,
            hostname: 'lab.engine.test',
            status: 'online',
            href: 'https://lab.engine.test/',
        },
        {
            name: 'Old',
            fingerprint: null,
            hostname: 'old.engine.test',
            status: 'offline',
            href: 'https://old.engine.test/',
        },
        {
            name: 'New',
            fingerprint: SAMPLE_FINGERPRINTS.lab,
            hostname: 'new.engine.test',
            status: 'unknown',
            href: 'https://new.engine.test/',
        },
    ],
};

describe('EngineSwitcher', () => {
    it.each(['light', 'dark'] as const)(
        'opens from the keyboard, moves with arrows and returns focus on Esc (%s)',
        async (theme) => {
            const { container, user } = renderUi(<EngineSwitcher {...DASHBOARD} />, { theme });
            const trigger = screen.getByRole('button', { name: /Acme engine/ });
            expect(trigger.getAttribute('aria-haspopup')).toBe('menu');

            await user.tab();
            expect(document.activeElement).toBe(trigger);
            await user.keyboard('{Enter}');
            const menu = screen.getByRole('menu', { name: 'Switch engine' });
            const current = within(menu).getByRole('menuitemradio', { name: 'Acme engine, acme.engine.test' });
            expect(current.getAttribute('aria-checked')).toBe('true');
            expect(document.activeElement).toBe(current);

            await user.keyboard('{ArrowDown}');
            expect(document.activeElement).toBe(
                within(menu).getByRole('menuitem', { name: 'Lab, lab.engine.test, Online' }),
            );
            await expectNoAxeViolations(container);

            await user.keyboard('{Escape}');
            expect(document.activeElement).toBe(trigger);
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
        },
    );

    it('opens with ArrowDown too', async () => {
        const { user } = renderUi(<EngineSwitcher {...ENGINE_UI} />);
        screen.getByRole('button', { name: /Acme engine/ }).focus();
        await user.keyboard('{ArrowDown}');
        expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio');
    });

    it('lists other engines and the dashboard as anchors with exactly the given hrefs and status text', () => {
        renderUi(<EngineSwitcher {...DASHBOARD} />);
        const menu = screen.getByRole('menu', { hidden: true });
        const links = within(menu)
            .getAllByRole('menuitem', { hidden: true })
            .map((item) => [
                item.tagName,
                item.getAttribute('href'),
                item.getAttribute('aria-label') ?? item.textContent,
            ]);
        expect(links).toEqual([
            ['A', 'https://lab.engine.test/', 'Lab, lab.engine.test, Online'],
            ['A', 'https://old.engine.test/', 'Old, old.engine.test, Offline'],
            ['A', 'https://new.engine.test/', 'New, new.engine.test, Status unknown'],
            ['A', 'https://app.ptbk.test', 'All engines'],
            ['A', 'https://app.ptbk.test/engines/new', 'Add engine'],
        ]);
        for (const status of ['Online', 'Offline', 'Status unknown']) {
            expect(within(menu).getByText(status)).toBeDefined();
        }
        expect(within(menu).getByRole('menuitemradio', { hidden: true }).getAttribute('href')).toBeNull();
    });

    it('shows only the current engine when there is no dashboard and no other engine', async () => {
        const { user } = renderUi(<EngineSwitcher {...ENGINE_UI} allEnginesHref={null} addEngineHref={null} />);
        await user.click(screen.getByRole('button', { name: /Acme engine/ }));
        const menu = screen.getByRole('menu');
        expect(within(menu).queryAllByRole('menuitem')).toEqual([]);
        expect(within(menu).queryByText('All engines')).toBeNull();
        expect(within(menu).queryByText('Add engine')).toBeNull();
        await user.click(within(menu).getByRole('menuitemradio'));
        expect(screen.getByRole('button', { name: /Acme engine/ }).getAttribute('aria-expanded')).toBe('false');
    });

    it('omits each dashboard link whose href is null', () => {
        renderUi(<EngineSwitcher {...ENGINE_UI} addEngineHref={null} />);
        const menu = screen.getByRole('menu', { hidden: true });
        expect(within(menu).getByText('All engines')).toBeDefined();
        expect(within(menu).queryByText('Add engine')).toBeNull();
    });

    it('keeps the name as the accessible name when compact', async () => {
        const { container } = renderUi(<EngineSwitcher {...ENGINE_UI} compact />);
        const trigger = screen.getByRole('button', { name: 'Switch engine: Acme engine' });
        expect(within(trigger).queryByText('Acme engine')).toBeNull();
        await expectNoAxeViolations(container);
    });
});
