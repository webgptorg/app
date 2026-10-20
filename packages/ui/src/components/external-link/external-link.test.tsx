import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { ExternalLink } from './external-link';

describe('ExternalLink', () => {
    it.each(['light', 'dark'] as const)(
        'opens in a new tab without an opener and shows the host (%s)',
        async (theme) => {
            const { container, user } = renderUi(
                <ExternalLink href="https://docs.ptbk.io/guide">{'Guide'}</ExternalLink>,
                {
                    theme,
                },
            );
            const link = screen.getByRole('link', { name: /^Guide\s*\(docs\.ptbk\.io\)\s*\(opens in a new tab\)$/ });
            expect(link.getAttribute('target')).toBe('_blank');
            expect(link.getAttribute('rel')).toBe('noopener noreferrer');
            expect(link.getAttribute('href')).toBe('https://docs.ptbk.io/guide');
            await user.tab();
            expect(document.activeElement).toBe(link);
            await expectNoAxeViolations(container);
        },
    );

    it('can hide the host', () => {
        renderUi(
            <ExternalLink href="http://example.test/" showHost={false}>
                {'Example'}
            </ExternalLink>,
        );
        expect(screen.getByRole('link').textContent).not.toContain('example.test');
    });

    it.each(['javascript:alert(1)', 'data:text/html,x', '/relative', 'not a url'])(
        'renders %s as text, never as a link',
        (href) => {
            renderUi(<ExternalLink href={href}>{'Unsafe'}</ExternalLink>);
            expect(screen.queryByRole('link')).toBeNull();
            expect(screen.getByText('Unsafe').tagName).toBe('SPAN');
        },
    );
});
