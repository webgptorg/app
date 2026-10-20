import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TEST_MESSAGES } from '../testing/test-messages';
import { createFormatters } from './formatters';
import { UiProvider, useLocale, useUiMessages } from './ui-provider';

describe('Intl formatters', () => {
    const now = new Date('2026-10-20T12:00:00.000Z');

    it('are memoised per locale', () => {
        expect(createFormatters('cs')).toBe(createFormatters('cs'));
        expect(createFormatters('cs')).not.toBe(createFormatters('en'));
    });

    it('format dates, numbers and relative times for the locale', () => {
        const en = createFormatters('en');
        const cs = createFormatters('cs');
        expect(en.formatNumber(12345.5)).toBe('12,345.5');
        expect(cs.formatNumber(12345.5)).toBe('12 345,5');
        expect(en.formatNumber(0.25, { style: 'percent' })).toBe('25%');
        expect(en.formatDate(now)).toBe('Oct 20, 2026');
        expect(cs.formatDate(now)).toBe('20. 10. 2026');
        expect(en.formatDateTime(now)).toMatch(/^Oct 20, 2026/);
        expect(en.formatRelativeTime(new Date(now.getTime() - 3 * 60_000), now)).toBe('3 minutes ago');
        expect(en.formatRelativeTime(new Date(now.getTime() + 2 * 86_400_000), now)).toBe('in 2 days');
        expect(en.formatRelativeTime(now, now)).toBe('now');
        expect(cs.formatRelativeTime(new Date(now.getTime() - 86_400_000), now)).toBe('včera');
    });
});

describe('UiProvider', () => {
    it('supplies the messages and formatters to components', () => {
        function Probe() {
            const messages = useUiMessages();
            const { locale } = useLocale();
            return <p>{`${messages.close()} ${locale}`}</p>;
        }
        render(
            <UiProvider messages={TEST_MESSAGES} locale="cs">
                <Probe />
            </UiProvider>,
        );
        expect(screen.getByText('Close cs')).toBeDefined();
    });

    it('fails loudly without a provider', () => {
        function Probe() {
            useUiMessages();
            return null;
        }
        expect(() => render(<Probe />)).toThrow(/UiProvider/);
    });
});
