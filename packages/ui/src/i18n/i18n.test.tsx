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

    it('format money from a decimal string exactly, keeping its own decimals', () => {
        const en = createFormatters('en');
        const cs = createFormatters('cs');
        expect(en.formatCurrency('0.42', 'USD')).toBe('$0.42');
        expect(en.formatCurrency('3', 'USD')).toBe('$3.00');
        expect(en.formatCurrency('0.0042', 'USD')).toBe('$0.0042');
        expect(en.formatCurrency('12345678901234.5', 'EUR')).toBe('€12,345,678,901,234.50');
        expect(cs.formatCurrency('1234.5', 'CZK')).toBe('1\u00a0234,50\u00a0Kč');
        expect(en.formatCurrency('100', 'JPY')).toBe('¥100');
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
