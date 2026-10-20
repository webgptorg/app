import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { DEFAULT_TOAST_DURATION_MS, useToast } from './toast-store';
import type { ToastApi } from './toast-store';
import { Toaster } from './toaster';

let api: ToastApi | undefined;
function Capture({ onApi }: { readonly onApi: (toastApi: ToastApi) => void }) {
    const toastApi = useToast();
    useEffect(() => {
        onApi(toastApi);
    }, [onApi, toastApi]);
    return null;
}
const keepApi = (toastApi: ToastApi) => {
    api = toastApi;
};
function toasts(): ToastApi {
    if (api === undefined) throw new Error('not rendered');
    return api;
}

function renderToaster(theme: 'light' | 'dark' = 'light') {
    return renderUi(
        <>
            <Capture onApi={keepApi} />
            <Toaster />
        </>,
        { theme },
    );
}

describe('Toaster', () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
        vi.useRealTimers();
        api = undefined;
    });

    it.each(['light', 'dark'] as const)(
        'is one polite live region, present before anything arrives (%s)',
        async (theme) => {
            const { container } = renderToaster(theme);
            const region = screen.getByRole('region', { name: 'Notifications' });
            expect(region.querySelectorAll('[aria-live]')).toHaveLength(1);
            expect(region.querySelector('[aria-live]')?.getAttribute('aria-live')).toBe('polite');

            act(() => {
                toasts().show({ tone: 'success', title: 'Agent saved', description: 'Members see it at once.' });
            });
            expect(screen.getByRole('listitem').textContent).toContain('Agent saved');
            expect(screen.getByRole('listitem').querySelector('svg[aria-hidden="true"]')).not.toBeNull();
            await expectNoAxeViolations(container);
        },
    );

    it('dismisses after the default duration, but keeps errors until dismissed', () => {
        renderToaster();
        act(() => {
            toasts().show({ tone: 'info', title: 'Copied' });
            toasts().show({ tone: 'danger', title: 'Could not stop the run' });
        });
        act(() => {
            vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS);
        });
        expect(screen.queryByText('Copied')).toBeNull();
        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByText('Could not stop the run')).toBeDefined();
    });

    it('dismisses from its button, by keyboard', async () => {
        const { user } = renderToaster();
        act(() => {
            toasts().show({ tone: 'warning', title: 'Engine is updating' });
        });
        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss' }));
        await user.keyboard('{Enter}');
        expect(screen.queryByText('Engine is updating')).toBeNull();
    });

    it('pauses the timer on hover and on focus, and resumes with the time left', () => {
        renderToaster();
        act(() => {
            toasts().show({ tone: 'info', title: 'Paused', durationMs: 1000 });
        });
        const item = screen.getByRole('listitem');
        act(() => {
            vi.advanceTimersByTime(600);
        });
        fireEvent.mouseEnter(item);
        act(() => {
            vi.advanceTimersByTime(5000);
        });
        expect(screen.getByText('Paused')).toBeDefined();
        fireEvent.mouseLeave(item);
        act(() => {
            vi.advanceTimersByTime(300);
        });
        expect(screen.getByText('Paused')).toBeDefined();

        const dismiss = screen.getByRole('button', { name: 'Dismiss' });
        act(() => {
            dismiss.focus();
        });
        act(() => {
            vi.advanceTimersByTime(5000);
        });
        expect(screen.getByText('Paused')).toBeDefined();
        act(() => {
            dismiss.blur();
        });
        act(() => {
            vi.advanceTimersByTime(200);
        });
        expect(screen.queryByText('Paused')).toBeNull();
    });

    it('reports a promise as one toast, from loading to success', async () => {
        renderToaster();
        let resolve: (value: string) => void = () => undefined;
        const pending = new Promise<string>((done) => {
            resolve = done;
        });
        let outcome: Promise<string> | undefined;
        act(() => {
            outcome = toasts().promise(pending, {
                loading: 'Saving',
                success: (name) => `Saved ${name}`,
                error: 'Not saved',
            });
        });
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
        expect(screen.getByText('Saving')).toBeDefined();
        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByText('Saving')).toBeDefined();

        await act(async () => {
            resolve('Lead bot');
            await outcome;
        });
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
        expect(screen.getByText('Saved Lead bot')).toBeDefined();
        act(() => {
            vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS);
        });
        expect(screen.queryByRole('listitem')).toBeNull();
    });

    it('reports a rejected promise as a sticky error and rethrows', async () => {
        renderToaster();
        const failure = new Error('boom');
        await act(async () => {
            await expect(
                toasts().promise(Promise.reject(failure), {
                    loading: 'Saving',
                    success: 'Saved',
                    error: (error) => `Not saved: ${(error as Error).message}`,
                }),
            ).rejects.toBe(failure);
        });
        expect(screen.getByText('Not saved: boom')).toBeDefined();
        await act(async () => {
            await expect(
                toasts().promise(Promise.resolve(1), { loading: 'L', success: 'Done', error: 'E' }),
            ).resolves.toBe(1);
        });
        expect(screen.getByText('Done')).toBeDefined();
        await act(async () => {
            await expect(
                toasts().promise(Promise.reject(failure), { loading: 'L', success: 'S', error: 'Failed' }),
            ).rejects.toBe(failure);
        });
        expect(screen.getByText('Failed')).toBeDefined();
    });

    it('needs a UiProvider', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(() => render(<Capture onApi={keepApi} />)).toThrow('useToast() needs a <UiProvider> above it');
    });
});
