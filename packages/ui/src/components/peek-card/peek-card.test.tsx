import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { PeekCard } from './peek-card';

describe('PeekCard', () => {
    it.each(['light', 'dark'] as const)('shows kind, status, title, line, facts and the action (%s)', async (theme) => {
        const onSelect = vi.fn();
        const { container } = renderUi(
            <p>
                <PeekCard
                    kind="Task"
                    status={{ tone: 'danger', label: 'Failed' }}
                    title="<b>Ship</b>"
                    description="Dependency missing."
                    facts={[
                        { label: 'Agent', value: 'Ada' },
                        { label: 'Took', value: '0:21' },
                    ]}
                    tint="#ffff66"
                    action={{ label: 'Open task', onSelect }}
                    secondary={<button type="button">{'Mention'}</button>}
                >
                    <span>{'Live step'}</span>
                </PeekCard>
            </p>,
            { theme },
        );
        expect(screen.getByText('Task')).toBeDefined();
        expect(screen.getByText('Failed')).toBeDefined();
        expect(screen.getByText('<b>Ship</b>')).toBeDefined();
        expect(container.querySelector('b')).toBeNull();
        expect(screen.getByText('Dependency missing.')).toBeDefined();
        expect(screen.getByText('Agent').nextElementSibling?.textContent).toBe('Ada');
        expect(screen.getByText('Live step')).toBeDefined();
        const open = screen.getByRole('button', { name: 'Open task' });
        expect(open.getAttribute('aria-keyshortcuts')).toBe('Enter');
        fireEvent.click(open);
        expect(onSelect).toHaveBeenCalledOnce();
        const card = container.querySelector('p > span') as HTMLElement;
        expect(card.style.getPropertyValue('--tint')).toBe('#ffff66');
        await expectNoAxeViolations(container);
    });

    it('opens on Enter anywhere but on another control', () => {
        const onSelect = vi.fn();
        const onMention = vi.fn();
        renderUi(
            <PeekCard
                kind="Agent"
                title="Ada"
                action={{ label: 'Open agent', onSelect }}
                secondary={
                    <button type="button" onClick={onMention}>
                        {'Mention'}
                    </button>
                }
            />,
        );
        fireEvent.keyDown(screen.getByText('Ada'), { key: 'Enter' });
        expect(onSelect).toHaveBeenCalledOnce();
        fireEvent.keyDown(screen.getByText('Ada'), { key: 'Escape' });
        fireEvent.keyDown(screen.getByRole('button', { name: 'Mention' }), { key: 'Enter' });
        expect(onSelect).toHaveBeenCalledOnce();
    });

    it('renders its action through `render`, e.g. as a link', () => {
        renderUi(
            <PeekCard
                kind="Run"
                title="Weekly report"
                tintClassName="[--tint:var(--color-success)]"
                action={{
                    label: 'Open run',
                    render: ({ children, ...props }) => (
                        <a href="/runs/1" {...props}>
                            {children}
                        </a>
                    ),
                }}
            />,
        );
        const link = screen.getByRole('link', { name: 'Open run' });
        const click = vi.fn((event: Event) => {
            event.preventDefault();
        });
        link.addEventListener('click', click);
        fireEvent.keyDown(screen.getByText('Weekly report'), { key: 'Enter' });
        expect(click).toHaveBeenCalledOnce();
    });

    it('is just the header and title without facts or actions, and ignores Enter', () => {
        const { container } = renderUi(<PeekCard kind="File" title="notes.md" />);
        fireEvent.keyDown(screen.getByText('notes.md'), { key: 'Enter' });
        expect(container.querySelector('kbd')).toBeNull();
        expect(container.querySelector('.border-t')).toBeNull();
    });
});
