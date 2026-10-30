import { screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { ConfirmDialog } from './confirm-dialog';
import type { ConfirmDialogProps } from './confirm-dialog';

function Harness(props: Partial<ConfirmDialogProps> & { onConfirmSpy: () => void }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                onClick={() => {
                    setOpen(true);
                }}
            >
                Delete agent
            </button>
            <ConfirmDialog
                open={open}
                onClose={() => {
                    setOpen(false);
                }}
                onConfirm={() => {
                    props.onConfirmSpy();
                    setOpen(false);
                }}
                title="Delete Lead bot?"
                description="Its chats and runs are deleted too."
                confirmLabel="Delete"
                tone="danger"
                {...(props.confirmPhrase === undefined ? {} : { confirmPhrase: props.confirmPhrase })}
            />
        </>
    );
}

describe('ConfirmDialog', () => {
    it.each(['light', 'dark'] as const)('asks with focus on Cancel and no axe violations (%s)', async (theme) => {
        const onConfirm = vi.fn();
        const { container, user } = renderUi(<Harness onConfirmSpy={onConfirm} />, { theme });
        await user.click(screen.getByRole('button', { name: 'Delete agent' }));
        expect(screen.getByRole('dialog', { name: 'Delete Lead bot?' })).toBeDefined();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
        await expectNoAxeViolations(container);

        await user.keyboard('{Enter}');
        expect(onConfirm).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete agent' }));
    });

    it('confirms without a phrase', async () => {
        const onConfirm = vi.fn();
        const { user } = renderUi(<Harness onConfirmSpy={onConfirm} />);
        await user.click(screen.getByRole('button', { name: 'Delete agent' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('keeps confirm disabled until the exact phrase is typed, and forgets it on close', async () => {
        const onConfirm = vi.fn();
        const { user } = renderUi(<Harness onConfirmSpy={onConfirm} confirmPhrase="Lead bot" />);
        await user.click(screen.getByRole('button', { name: 'Delete agent' }));
        const phrase = screen.getByRole('textbox', { name: 'Type Lead bot to confirm' });
        expect(document.activeElement).toBe(phrase);
        const confirm = screen.getByRole('button', { name: 'Delete' });
        expect(confirm.hasAttribute('disabled')).toBe(true);

        await user.type(phrase, 'Lead bo');
        expect(confirm.hasAttribute('disabled')).toBe(true);
        await user.keyboard('{Escape}');
        await user.click(screen.getByRole('button', { name: 'Delete agent' }));
        const fresh = screen.getByRole('textbox', { name: 'Type Lead bot to confirm' });
        expect((fresh as HTMLInputElement).value).toBe('');

        await user.type(fresh, 'Lead bot');
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('marks the confirm button busy while loading', () => {
        renderUi(
            <ConfirmDialog
                open
                loading
                onClose={() => undefined}
                onConfirm={() => Promise.resolve()}
                title="Stop run?"
                confirmLabel="Stop"
            />,
        );
        expect(screen.getByRole('button', { name: 'Stop' }).getAttribute('aria-busy')).toBe('true');
    });

    it('shows why the last attempt failed and stays open for a retry', async () => {
        const onConfirm = vi.fn();
        const { container, user } = renderUi(
            <ConfirmDialog
                open
                onClose={() => undefined}
                onConfirm={onConfirm}
                title="Delete Lead bot?"
                confirmLabel="Delete"
                tone="danger"
                error="The engine refused."
            />,
        );
        expect(screen.getByRole('alert').textContent).toContain('The engine refused.');
        await expectNoAxeViolations(container);
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('shows details under the description, before the phrase field', () => {
        renderUi(
            <ConfirmDialog
                open
                onClose={() => undefined}
                onConfirm={() => undefined}
                title="Delete Lead bot?"
                description="This cannot be undone."
                confirmLabel="Delete"
                tone="danger"
                confirmPhrase="Lead bot"
            >
                <ul>
                    <li>Its chats go too.</li>
                </ul>
            </ConfirmDialog>,
        );
        const dialog = screen.getByRole('dialog', { name: 'Delete Lead bot?' });
        const item = screen.getByText('Its chats go too.');
        expect(dialog.contains(item)).toBe(true);
        const field = screen.getByRole('textbox');
        expect(item.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});
