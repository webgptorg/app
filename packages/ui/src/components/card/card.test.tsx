import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Card } from './card';

describe('Card', () => {
    it.each(['light', 'dark'] as const)(
        'is a region named by its title, with its actions reachable (%s)',
        async (theme) => {
            const { container, user } = renderUi(
                <Card title="Recent runs" actions={<button type="button">{'View all'}</button>}>
                    <p>{'Body'}</p>
                </Card>,
                { theme },
            );
            expect(screen.getByRole('region', { name: 'Recent runs' })).toBeDefined();
            expect(screen.getByRole('heading', { level: 2, name: 'Recent runs' })).toBeDefined();
            await user.tab();
            expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View all' }));
            await expectNoAxeViolations(container);
        },
    );

    it('renders a level-3 heading in an article, or no header at all', () => {
        const { container } = renderUi(
            <>
                <Card as="article" title="Agent" titleLevel={3}>
                    {'A'}
                </Card>
                <Card as="div">{'Plain'}</Card>
            </>,
        );
        expect(screen.getByRole('heading', { level: 3, name: 'Agent' }).closest('article')).not.toBeNull();
        expect(container.querySelectorAll('header')).toHaveLength(1);
    });

    it('renders actions without a title', () => {
        renderUi(<Card actions={<button type="button">{'Act'}</button>}>{'Body'}</Card>);
        expect(screen.queryByRole('heading')).toBeNull();
        expect(screen.getByRole('button', { name: 'Act' })).toBeDefined();
    });
});
