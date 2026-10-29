import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { CodeText } from './code-text';

describe('CodeText', () => {
    it.each(['light', 'dark'] as const)(
        'groups visually but keeps the exact value, with a copy button (%s)',
        async (theme) => {
            const { container, user } = renderUi(
                <CodeText value="ABCDEFGHIJ" group={4} copyable copyLabel="Copy fingerprint" />,
                { theme },
            );
            const code = container.querySelector('code');
            expect(code?.textContent).toBe('ABCDEFGHIJ');
            expect([...(code?.querySelectorAll(':scope > span') ?? [])].map((part) => part.textContent)).toEqual([
                'ABCD',
                'EFGH',
                'IJ',
            ]);
            // Lines may break between groups only, never inside one that fits.
            expect(code?.querySelectorAll(':scope > wbr')).toHaveLength(2);
            expect(code?.className).toContain('break-words');
            expect(code?.className).not.toContain('wrap-anywhere');
            await user.tab();
            expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy fingerprint' }));
            await expectNoAxeViolations(container);
        },
    );

    it('copies the unformatted value', async () => {
        const { user } = renderUi(<CodeText value="ABCDEFGH" group={4} copyable />);
        // After renderUi: user-event installs its own clipboard stub in setup().
        const writeText = vi.fn(() => Promise.resolve());
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        await user.click(screen.getByRole('button', { name: 'Copy' }));
        expect(writeText).toHaveBeenCalledWith('ABCDEFGH');
        Reflect.deleteProperty(navigator, 'clipboard');
    });

    it('breaks a hostname only after a dot, keeping the exact value', () => {
        const value = 'hd55ioeq5ltpqc7hnunajz4tnb.engines.ptbk.test';
        const { container } = renderUi(<CodeText value={value} kind="hostname" group={4} />);
        const code = container.querySelector('code');
        expect(code?.textContent).toBe(value);
        expect([...(code?.querySelectorAll(':scope > span') ?? [])].map((part) => part.textContent)).toEqual([
            'hd55ioeq5ltpqc7hnunajz4tnb.',
            'engines.',
            'ptbk.',
            'test',
        ]);
        expect(code?.querySelectorAll(':scope > wbr')).toHaveLength(3);
        expect(code?.querySelector('.ms-1')).toBeNull();
        expect(code?.className).toContain('break-words');
    });

    it.each([
        ['localhost', ['localhost']],
        ['a..b.', ['a.', '.', 'b.']],
    ])('splits the hostname %s without losing a character', (value, parts) => {
        const { container } = renderUi(<CodeText value={value} kind="hostname" />);
        const code = container.querySelector('code');
        expect(code?.textContent).toBe(value);
        expect([...(code?.querySelectorAll(':scope > span') ?? [])].map((part) => part.textContent)).toEqual(parts);
    });

    it.each([undefined, 0])('shows one group without grouping (%s) and no button unless copyable', (group) => {
        const { container } = renderUi(<CodeText value="abc" {...(group === undefined ? {} : { group })} />);
        expect(container.querySelectorAll('code > span')).toHaveLength(1);
        expect(container.querySelector('code')?.className).toContain('wrap-anywhere');
        expect(screen.queryByRole('button')).toBeNull();
    });
});
