import { screen } from '@testing-library/react';
import { X } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { IconButton } from './icon-button';

describe('IconButton', () => {
    it.each(['light', 'dark'] as const)('is named by its label and keyboard-operable (%s)', async (theme) => {
        const onClick = vi.fn();
        const { container, user } = renderUi(<IconButton label="Close" icon={<X />} onClick={onClick} />, { theme });
        const button = screen.getByRole('button', { name: 'Close' });
        expect(container.querySelector('svg')?.closest('[aria-hidden="true"]')).not.toBeNull();
        await user.tab();
        expect(document.activeElement).toBe(button);
        await user.keyboard('{Enter}');
        expect(onClick).toHaveBeenCalledOnce();
        await expectNoAxeViolations(container);
    });

    it('ignores clicks while loading and shows a spinner instead of the icon', async () => {
        const onClick = vi.fn();
        const { user, container } = renderUi(<IconButton label="Save" icon={<X />} loading onClick={onClick} />);
        const button = screen.getByRole('button', { name: 'Save' });
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(container.querySelectorAll('svg')).toHaveLength(1);
        await user.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });

    it('stays focusable with a reason when disabled with one', async () => {
        const onClick = vi.fn();
        const { user } = renderUi(
            <IconButton
                label="Delete"
                icon={<X />}
                disabled
                disabledReason="Needs agents.delete"
                aria-describedby="other"
                onClick={onClick}
            />,
        );
        const button = screen.getByRole('button', { name: 'Delete' });
        expect(button.getAttribute('aria-disabled')).toBe('true');
        const [other, reason] = (button.getAttribute('aria-describedby') ?? '').split(' ');
        expect(other).toBe('other');
        expect(document.getElementById(reason ?? '')?.textContent).toBe('Needs agents.delete');
        await user.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });

    it('is natively disabled without a reason and renders nothing when hidden', () => {
        renderUi(
            <>
                <IconButton label="Archive" icon={<X />} disabled size="sm" />
                <IconButton label="Secret" icon={<X />} hidden />
            </>,
        );
        expect(screen.getByRole('button', { name: 'Archive' }).hasAttribute('disabled')).toBe(true);
        expect(screen.queryByRole('button', { name: 'Secret' })).toBeNull();
    });
});
