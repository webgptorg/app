import { screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
    it.each(['light', 'dark'] as const)('says what is missing and offers the next step (%s)', async (theme) => {
        const { container, user } = renderUi(
            <EmptyState
                title="No agents yet"
                description="Create your first agent."
                icon={<Inbox />}
                action={<button type="button">{'New agent'}</button>}
            />,
            { theme },
        );
        expect(screen.getByText('No agents yet')).toBeDefined();
        expect(screen.getByText('Create your first agent.')).toBeDefined();
        expect(container.querySelector('svg')?.closest('[aria-hidden="true"]')).not.toBeNull();
        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New agent' }));
        await expectNoAxeViolations(container);
    });

    it('renders just a title', () => {
        const { container } = renderUi(<EmptyState title="Nothing here" />);
        expect(container.querySelectorAll('p')).toHaveLength(1);
        expect(container.querySelector('svg')).toBeNull();
    });

    it('is one quiet line with its action at the end, inline', async () => {
        const { container } = renderUi(
            <EmptyState
                variant="inline"
                title="No runs yet"
                description="They show here."
                icon={<Inbox />}
                action={<button type="button">{'Run now'}</button>}
            />,
        );
        expect(screen.getByText('No runs yet').tagName).toBe('P');
        expect(screen.getByText('They show here.')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Run now' }).parentElement?.className).toMatch(/ms-auto/);
        await expectNoAxeViolations(container);
        renderUi(<EmptyState variant="inline" title="Bare" />);
        expect(screen.getByText('Bare')).toBeDefined();
    });

    it('makes the title a heading when asked to', () => {
        renderUi(<EmptyState title="No access" headingLevel={1} />);
        expect(screen.getByRole('heading', { level: 1, name: 'No access' })).toBeDefined();
    });

    it('shows an illustration in place of the icon', () => {
        const { container } = renderUi(
            <EmptyState title="No engines yet" icon={<Inbox />} illustration={<svg data-testid="robot" />} />,
        );
        expect(screen.getByTestId('robot').closest('[aria-hidden="true"]')).not.toBeNull();
        expect(container.querySelectorAll('svg')).toHaveLength(1);
    });
});
