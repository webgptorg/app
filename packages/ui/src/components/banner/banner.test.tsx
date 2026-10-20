import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Banner } from './banner';

describe('Banner', () => {
    it.each(['light', 'dark'] as const)('alerts for danger, with a keyboard-reachable dismiss (%s)', async (theme) => {
        const onDismiss = vi.fn();
        const { container, user } = renderUi(
            <Banner tone="danger" title="Certificate mismatch" onDismiss={onDismiss}>
                {'A foreign certificate was found.'}
            </Banner>,
            { theme },
        );
        const alert = screen.getByRole('alert');
        expect(alert.textContent).toContain('Certificate mismatch');
        expect(alert.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss' }));
        await user.keyboard('{Enter}');
        expect(onDismiss).toHaveBeenCalledOnce();
        await expectNoAxeViolations(container);
    });

    it.each([
        ['info', 'status'],
        ['success', 'status'],
        ['warning', 'alert'],
    ] as const)('uses role %s for %s', (tone, role) => {
        renderUi(<Banner tone={tone}>{'Message'}</Banner>);
        expect(screen.getByRole(role).textContent).toBe('Message');
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('renders an action and defaults to info', () => {
        renderUi(<Banner action={<button type="button">{'Update now'}</button>}>{'An update is available.'}</Banner>);
        expect(screen.getByRole('status')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Update now' })).toBeDefined();
    });
});
