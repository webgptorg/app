import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { COPY_FEEDBACK_MS, CopyButton } from './copy-button';

describe('CopyButton', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(['light', 'dark'] as const)('copies the value and announces it (%s)', async (theme) => {
        const copy = vi.fn(() => Promise.resolve());
        const { container, user } = renderUi(<CopyButton value="abc123" copy={copy} />, { theme });
        const button = screen.getByRole('button', { name: 'Copy' });
        await user.tab();
        expect(document.activeElement).toBe(button);
        await user.keyboard('{Enter}');
        expect(copy).toHaveBeenCalledWith('abc123');
        expect(await screen.findByText('Copied')).toBeDefined();
        expect(screen.getByRole('status').textContent).toBe('Copied');
        await expectNoAxeViolations(container);
    });

    it('can show its label, and says "Copied" in its place for the feedback time', async () => {
        vi.useFakeTimers();
        const copy = vi.fn(() => Promise.resolve());
        const { container } = renderUi(
            <CopyButton value="install --code x" label="Copy command" copy={copy} variant="secondary" showLabel />,
        );
        const button = screen.getByRole('button', { name: 'Copy command' });
        expect(button.textContent).toBe('Copy command');
        await act(async () => {
            button.click();
            await Promise.resolve();
        });
        expect(copy).toHaveBeenCalledWith('install --code x');
        expect(button.textContent).toBe('Copied');
        expect(screen.getByRole('status').textContent).toBe('Copied');
        act(() => {
            vi.advanceTimersByTime(COPY_FEEDBACK_MS);
        });
        expect(button.textContent).toBe('Copy command');
        vi.useRealTimers();
        await expectNoAxeViolations(container);
    });

    it('announces a failure and resets after the feedback time', async () => {
        vi.useFakeTimers();
        const copy = vi.fn(() => Promise.reject(new Error('denied')));
        renderUi(<CopyButton value="x" label="Copy engine ID" copy={copy} variant="secondary" className="y" />);
        await act(async () => {
            screen.getByRole('button', { name: 'Copy engine ID' }).click();
            await Promise.resolve();
        });
        expect(screen.getByRole('status').textContent).toBe('Could not copy');
        act(() => {
            vi.advanceTimersByTime(COPY_FEEDBACK_MS);
        });
        expect(screen.getByRole('status').textContent).toBe('');
    });

    it('uses the Clipboard API by default and fails cleanly without it', async () => {
        const writeText = vi.fn(() => Promise.resolve());
        const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
        // After renderUi: user-event installs its own clipboard stub in setup().
        const { unmount } = renderUi(<CopyButton value="v" />);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        await act(async () => {
            screen.getByRole('button', { name: 'Copy' }).click();
            await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledWith('v');
        unmount();

        renderUi(<CopyButton value="v" />);
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        await act(async () => {
            screen.getByRole('button', { name: 'Copy' }).click();
            await Promise.resolve();
        });
        expect(screen.getByRole('status').textContent).toBe('Could not copy');
        if (descriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard');
        else Object.defineProperty(navigator, 'clipboard', descriptor);
    });
});
