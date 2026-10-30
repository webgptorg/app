import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { LanguageSwitch } from './language-switch';

const LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'cs', name: 'Čeština' },
] as const;

describe('LanguageSwitch', () => {
    it.each(['light', 'dark'] as const)(
        'shows the current code, named for screen readers, and lists languages in their own names (%s)',
        async (theme) => {
            const { container, user } = renderUi(
                <LanguageSwitch languages={LANGUAGES} current="cs" onChange={vi.fn()} />,
                { theme },
            );
            const trigger = screen.getByRole('button', { name: 'CS, Language: Čeština' });
            expect(trigger.textContent).toBe('CS');
            expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
            await expectNoAxeViolations(container);

            await user.click(trigger);
            const menu = screen.getByRole('menu', { name: 'Language' });
            const czech = within(menu).getByRole('menuitemradio', { name: 'Čeština' });
            expect(czech.getAttribute('aria-checked')).toBe('true');
            expect(within(menu).getByRole('menuitemradio', { name: 'English' }).getAttribute('aria-checked')).toBe(
                'false',
            );
            expect(within(czech).getByText('Čeština').getAttribute('lang')).toBe('cs');
            await expectNoAxeViolations(container);
        },
    );

    it('changes the language from the keyboard and returns focus to the trigger', async () => {
        const onChange = vi.fn();
        const { user } = renderUi(<LanguageSwitch languages={LANGUAGES} current="en" onChange={onChange} />);
        const trigger = screen.getByRole('button', { name: 'EN, Language: English' });
        await user.tab();
        expect(document.activeElement).toBe(trigger);
        await user.keyboard('{Enter}');
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'English' }));
        await user.keyboard('{ArrowDown}{Enter}');
        expect(onChange).toHaveBeenCalledExactlyOnceWith('cs');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('does not report choosing the language that is already current', async () => {
        const onChange = vi.fn();
        const { user } = renderUi(<LanguageSwitch languages={LANGUAGES} current="en" onChange={onChange} />);
        await user.click(screen.getByRole('button', { name: 'EN, Language: English' }));
        await user.click(screen.getByRole('menuitemradio', { name: 'English' }));
        expect(onChange).not.toHaveBeenCalled();
    });

    it('names an unlisted current language by its code', () => {
        renderUi(<LanguageSwitch languages={LANGUAGES} current={'de' as 'en'} onChange={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'DE, Language: de' }).textContent).toBe('DE');
    });
});
