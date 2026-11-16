import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { ErrorState } from './error-state';

describe('ErrorState', () => {
    it.each(['light', 'dark'] as const)('alerts with a message, a retry and details (%s)', async (theme) => {
        const onRetry = vi.fn();
        const { container, user } = renderUi(
            <ErrorState message="The engine did not answer." onRetry={onRetry} details="problem: timeout" />,
            { theme },
        );
        const alert = screen.getByRole('alert');
        expect(alert.textContent).toContain('Something went wrong');
        expect(alert.textContent).toContain('The engine did not answer.');
        await user.tab();
        const retry = screen.getByRole('button', { name: 'Try again' });
        expect(document.activeElement).toBe(retry);
        await user.keyboard('{Enter}');
        expect(onRetry).toHaveBeenCalledOnce();
        expect(screen.getByText('Details').tagName).toBe('SUMMARY');
        expect(screen.getByText('problem: timeout')).toBeDefined();
        await expectNoAxeViolations(container);
    });

    it('takes a custom title, marks a retry in flight busy, and can omit retry and details', () => {
        const { rerender } = renderUi(
            <ErrorState title="No access" message="Ask an admin." onRetry={vi.fn()} retrying />,
        );
        expect(screen.getByText('No access')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-busy')).toBe('true');
        rerender(<ErrorState title="No access" message="Ask an admin." />);
        expect(screen.queryByRole('button')).toBeNull();
        expect(document.querySelector('details')).toBeNull();
    });

    it('shows an illustration in place of the alert icon', () => {
        const { container } = renderUi(<ErrorState message="Gone." illustration={<svg data-testid="robot" />} />);
        expect(screen.getByTestId('robot').closest('[aria-hidden="true"]')).not.toBeNull();
        expect(container.querySelectorAll('svg')).toHaveLength(1);
    });
});
