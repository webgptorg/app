import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Button } from '../button/button';
import { Dialog } from '../dialog/dialog';
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
            expect(container.contains(region)).toBe(false);
            expect(region.dataset['fakePopoverOpen']).toBe('true');
            await expectNoAxeViolations(document.body);
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

    it('wraps long unbroken names instead of running out of the card', () => {
        renderToaster();
        act(() => {
            toasts().show({ tone: 'success', title: 'Secret SLACK_WEBHOOK_URL_FOR_THE_SUPPORT_TEAM saved' });
        });
        expect(screen.getByText(/SLACK_WEBHOOK/).className).toContain('wrap-anywhere');
    });

    describe('over a modal dialog', () => {
        function Harness({ nested = false }: { readonly nested?: boolean }) {
            const [open, setOpen] = useState<readonly string[]>([]);
            const close = (name: string) => {
                setOpen((current) => current.filter((entry) => entry !== name));
            };
            return (
                <>
                    <Capture onApi={keepApi} />
                    <Button
                        onClick={() => {
                            setOpen(['Delete Ada?']);
                        }}
                    >
                        Open
                    </Button>
                    <Dialog
                        open={open.includes('Delete Ada?')}
                        onClose={() => {
                            close('Delete Ada?');
                        }}
                        title="Delete Ada?"
                    >
                        <Button
                            onClick={() => {
                                setOpen((current) => [...current, 'Confirm with passkey']);
                            }}
                        >
                            Continue
                        </Button>
                        <Button
                            onClick={() => {
                                setOpen([]);
                            }}
                        >
                            Unmount all
                        </Button>
                    </Dialog>
                    {nested ? (
                        <Dialog
                            open={open.includes('Confirm with passkey')}
                            onClose={() => {
                                close('Confirm with passkey');
                            }}
                            title="Confirm with passkey"
                        >
                            <p>Touch your security key.</p>
                        </Dialog>
                    ) : null}
                    <Toaster />
                </>
            );
        }

        const region = () => screen.getByRole('region', { name: 'Notifications', hidden: true });
        const dialogNamed = (name: string) => screen.getByRole('dialog', { name });

        it.each(['light', 'dark'] as const)(
            'moves into the open dialog, so its toasts are reachable and announced, then back out (%s)',
            async (theme) => {
                const { user } = renderUi(<Harness />, { theme });
                act(() => {
                    toasts().show({ tone: 'info', title: 'Copied' });
                });
                await user.click(screen.getByRole('button', { name: 'Open' }));
                const dialog = dialogNamed('Delete Ada?');
                await waitFor(() => {
                    expect(dialog.contains(region())).toBe(true);
                });
                expect(region().dataset['fakePopoverOpen']).toBe('true');
                expect(screen.getByText('Copied')).toBeDefined();

                act(() => {
                    toasts().show({ tone: 'danger', title: 'This device is the last passkey' });
                });
                const live = region().querySelector('[aria-live="polite"]');
                expect(live?.textContent).toContain('This device is the last passkey');
                await expectNoAxeViolations(document.body);

                const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss' });
                await user.tab();
                await user.tab();
                await user.tab();
                await user.tab();
                expect(dismissButtons).toContain(document.activeElement);

                await user.keyboard('{Escape}');
                await waitFor(() => {
                    expect(region().parentElement?.parentElement).toBe(document.body);
                });
                expect(screen.getByText('This device is the last passkey')).toBeDefined();
            },
        );

        it('follows the topmost of stacked dialogs and returns to the one below', async () => {
            const { user } = renderUi(<Harness nested />);
            await user.click(screen.getByRole('button', { name: 'Open' }));
            await user.click(screen.getByRole('button', { name: 'Continue' }));
            await waitFor(() => {
                expect(dialogNamed('Confirm with passkey').contains(region())).toBe(true);
            });
            await user.keyboard('{Escape}');
            await waitFor(() => {
                expect(dialogNamed('Delete Ada?').contains(region())).toBe(true);
            });
        });

        it('returns to the body when the open dialog leaves the DOM', async () => {
            const { user } = renderUi(<Harness />);
            await user.click(screen.getByRole('button', { name: 'Open' }));
            await waitFor(() => {
                expect(dialogNamed('Delete Ada?').contains(region())).toBe(true);
            });
            await user.click(screen.getByRole('button', { name: 'Unmount all' }));
            await waitFor(() => {
                expect(region().isConnected).toBe(true);
            });
            expect(region().parentElement?.parentElement).toBe(document.body);
        });

        it('starts inside a dialog that is already open when it mounts, and leaves nothing behind', async () => {
            const { unmount } = renderUi(
                <Dialog open onClose={() => undefined} title="Already open">
                    <Capture onApi={keepApi} />
                    <Toaster />
                </Dialog>,
            );
            await waitFor(() => {
                expect(dialogNamed('Already open').contains(region())).toBe(true);
            });
            unmount();
            expect(screen.queryByRole('region', { name: 'Notifications', hidden: true })).toBeNull();
        });
    });

    it('needs a UiProvider', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(() => render(<Capture onApi={keepApi} />)).toThrow('useToast() needs a <UiProvider> above it');
    });
});
