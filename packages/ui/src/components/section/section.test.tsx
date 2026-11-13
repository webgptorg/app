import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Section } from './section';

describe('Section', () => {
    it.each(['light', 'dark'] as const)('is a named region: heading, count, actions, content (%s)', async (theme) => {
        const { container } = renderUi(
            <Section
                title="Working now"
                count={3}
                description="Live steps."
                actions={<button type="button">{'All'}</button>}
            >
                <p>{'Rows'}</p>
            </Section>,
            { theme },
        );
        const region = screen.getByRole('region', { name: /Working now/ });
        expect(region.className).toMatch(/border-t/);
        expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Working now3');
        expect(screen.getByText('3').className).toMatch(/tabular-nums/);
        expect(screen.getByText('Live steps.')).toBeDefined();
        expect(screen.getByRole('button', { name: 'All' })).toBeDefined();
        await expectNoAxeViolations(container);
    });

    it('can be the first section, a div, an h3, or headless', () => {
        const { container } = renderUi(
            <>
                <Section title="First" titleLevel={3} divided={false} as="div">
                    <p>{'A'}</p>
                </Section>
                <Section>
                    <p>{'B'}</p>
                </Section>
            </>,
        );
        expect(screen.getByRole('heading', { level: 3, name: 'First' })).toBeDefined();
        expect(container.querySelector('div')?.className).not.toMatch(/border-t/);
        expect(container.querySelectorAll('header')).toHaveLength(1);
    });
});
