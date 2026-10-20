import { screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Tabs } from './tabs';
import type { TabsProps } from './tabs';

const TABS = [
    { id: 'overview', label: 'Overview', panel: <p>Overview panel</p> },
    { id: 'chat', label: 'Chat', panel: <p>Chat panel</p> },
    { id: 'book', label: 'Book', panel: <p>Book panel</p>, disabled: true },
    { id: 'runs', label: 'Runs', panel: <p>Runs panel</p> },
];

function Controlled(props: Partial<TabsProps> & { onSelectSpy?: (id: string) => void }) {
    const [selectedId, setSelectedId] = useState('overview');
    return (
        <Tabs
            label="Agent"
            tabs={TABS}
            selectedId={selectedId}
            onSelect={(id) => {
                props.onSelectSpy?.(id);
                setSelectedId(id);
            }}
            {...(props.activation === undefined ? {} : { activation: props.activation })}
        />
    );
}

describe('Tabs', () => {
    it.each(['light', 'dark'] as const)(
        'links tabs and the selected panel without axe violations (%s)',
        async (theme) => {
            const { container } = renderUi(<Controlled />, { theme });
            expect(screen.getByRole('tablist', { name: 'Agent' })).toBeDefined();
            const overview = screen.getByRole('tab', { name: 'Overview' });
            expect(overview.getAttribute('aria-selected')).toBe('true');
            const panel = screen.getByRole('tabpanel', { name: 'Overview' });
            expect(overview.getAttribute('aria-controls')).toBe(panel.id);
            expect(screen.queryByText('Chat panel')).toBeNull();
            await expectNoAxeViolations(container);
        },
    );

    it('is one tab stop and selects with arrows, Home and End, skipping disabled tabs', async () => {
        const { user } = renderUi(<Controlled />);
        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Overview' }));
        await user.keyboard('{ArrowRight}');
        expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByText('Chat panel')).toBeDefined();
        await user.keyboard('{ArrowRight}');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Runs' }));
        await user.keyboard('{ArrowRight}');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Overview' }));
        await user.keyboard('{ArrowLeft}');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Runs' }));
        await user.keyboard('{Home}');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Overview' }));
        await user.keyboard('{End}');
        expect(screen.getByRole('tab', { name: 'Runs' }).getAttribute('aria-selected')).toBe('true');
        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('tabpanel'));
    });

    it('moves focus without selecting in manual mode until Enter', async () => {
        const onSelect = vi.fn();
        const { user } = renderUi(<Controlled activation="manual" onSelectSpy={onSelect} />);
        await user.tab();
        await user.keyboard('{ArrowRight}');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Chat' }));
        expect(onSelect).not.toHaveBeenCalled();
        await user.keyboard('a{Enter}');
        expect(onSelect).toHaveBeenCalledWith('chat');
        await user.click(screen.getByRole('tab', { name: 'Runs' }));
        expect(onSelect).toHaveBeenLastCalledWith('runs');
    });

    it('falls back to the first enabled tab for an unknown selection', () => {
        renderUi(<Tabs label="Agent" tabs={TABS} selectedId="missing" onSelect={() => undefined} />);
        expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
    });

    it('reverses arrow keys right to left and renders no panel without tabs', async () => {
        const { user } = renderUi(
            <div dir="rtl">
                <Controlled />
            </div>,
        );
        const list = screen.getByRole('tablist');
        list.style.direction = 'rtl';
        await user.tab();
        await user.keyboard('{ArrowLeft}');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Chat' }));
        renderUi(<Tabs label="Empty" tabs={[]} selectedId="x" onSelect={() => undefined} />);
        expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    });

    it('renders custom triggers, such as links, that keep the tabs pattern', async () => {
        const onSelect = vi.fn();
        const { container, user } = renderUi(
            <Tabs
                label="Agent"
                tabs={TABS}
                selectedId="chat"
                onSelect={onSelect}
                activation="manual"
                renderTab={(tab, { children, ...props }) => (
                    <a href={`#${tab.id}`} {...props}>
                        {children}
                    </a>
                )}
            />,
        );
        const chat = screen.getByRole('tab', { name: 'Chat' });
        expect(chat.tagName).toBe('A');
        expect(chat.getAttribute('aria-selected')).toBe('true');
        expect(chat.getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel', { name: 'Chat' }).id);
        await expectNoAxeViolations(container);

        await user.tab();
        expect(document.activeElement).toBe(chat);
        await user.keyboard('{ArrowRight}');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Runs' }));
        await user.click(screen.getByRole('tab', { name: 'Overview' }));
        expect(onSelect).not.toHaveBeenCalled();
    });
});
