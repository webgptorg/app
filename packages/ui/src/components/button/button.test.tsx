import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Button } from './button';

describe('Button', () => {
    it.each(['light', 'dark'] as const)(
        'is a named, keyboard-operable button without axe violations (%s)',
        async (theme) => {
            const onClick = vi.fn();
            const { container, user } = renderUi(
                <Button variant="primary" onClick={onClick}>
                    {'Save'}
                </Button>,
                { theme },
            );
            const button = screen.getByRole('button', { name: 'Save' });
            expect(button.getAttribute('type')).toBe('button');

            await user.tab();
            expect(document.activeElement).toBe(button);
            await user.keyboard('{Enter}');
            await user.keyboard(' ');
            expect(onClick).toHaveBeenCalledTimes(2);
            await expectNoAxeViolations(container);
        },
    );

    it('marks itself busy while loading and ignores clicks, keeping its label', async () => {
        const onClick = vi.fn();
        const { user } = renderUi(
            <Button loading onClick={onClick}>
                {'Save'}
            </Button>,
        );
        const button = screen.getByRole('button', { name: 'Save' });
        expect(button.getAttribute('aria-busy')).toBe('true');
        await user.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });

    it('stays focusable and explains itself when disabled with a reason', async () => {
        const onClick = vi.fn();
        const { user } = renderUi(
            <Button disabled disabledReason="You need the agents.delete permission" onClick={onClick}>
                {'Delete'}
            </Button>,
        );
        const button = screen.getByRole('button', { name: 'Delete' });
        expect(button.hasAttribute('disabled')).toBe(false);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        const describedBy = button.getAttribute('aria-describedby') ?? '';
        expect(document.getElementById(describedBy)?.textContent).toBe('You need the agents.delete permission');
        const reason = document.getElementById(describedBy);
        expect(reason?.getAttribute('role')).toBe('tooltip');
        expect(reason?.dataset['fakePopoverOpen']).toBeUndefined();
        await user.tab();
        expect(document.activeElement).toBe(button);
        expect(reason?.dataset['fakePopoverOpen']).toBe('true');
        await user.click(button);
        expect(onClick).not.toHaveBeenCalled();
        expect(reason?.dataset['fakePopoverOpen']).toBe('true');
    });

    it.each(['primary', 'secondary', 'ghost', 'danger'] as const)(
        'looks inert through disabled tokens, not opacity (%s)',
        (variant) => {
            renderUi(
                <Button variant={variant} disabled>
                    {'Save'}
                </Button>,
            );
            const classes = screen.getByRole('button', { name: 'Save' }).className;
            expect(classes).toContain('disabled:text-(--button-disabled-text)');
            expect(classes).not.toContain('opacity');
            expect(classes).not.toContain('transition-colors');
        },
    );

    it('is natively disabled without a reason, and renders nothing when hidden', () => {
        renderUi(
            <>
                <Button disabled>{'Archive'}</Button>
                <Button hidden>{'Secret'}</Button>
            </>,
        );
        expect(screen.getByRole('button', { name: 'Archive' }).hasAttribute('disabled')).toBe(true);
        expect(screen.queryByRole('button', { name: 'Secret' })).toBeNull();
    });

    it('styles a secondary destructive action as danger text without a fill', () => {
        renderUi(<Button variant="danger-ghost">{'Sign out everywhere'}</Button>);
        const button = screen.getByRole('button', { name: 'Sign out everywhere' });
        expect(button.className).toContain('text-(--button-danger-ghost-text)');
        expect(button.className).not.toContain('bg-(--button-danger-bg)');
    });

    it('submits forms when asked to', () => {
        const onSubmit = vi.fn((event: { preventDefault: () => void }) => {
            event.preventDefault();
        });
        renderUi(
            <form onSubmit={onSubmit}>
                <Button type="submit" variant="danger">
                    {'Send'}
                </Button>
            </form>,
        );
        screen.getByRole('button', { name: 'Send' }).click();
        expect(onSubmit).toHaveBeenCalledOnce();
    });
});
