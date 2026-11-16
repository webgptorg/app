import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderUi } from '../../testing/render-ui';
import { ExternalChip, SecurityNote } from './security-parts';

describe('ExternalChip', () => {
    it('opens an http(s) address in a new tab without access to this page', () => {
        renderUi(<ExternalChip href="https://search.sigstore.dev/?logIndex=1">Rekor</ExternalChip>);
        const link = screen.getByRole('link', { name: /Rekor/ });
        expect(link.getAttribute('href')).toBe('https://search.sigstore.dev/?logIndex=1');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.getAttribute('target')).toBe('_blank');
    });

    it.each(['javascript:alert(1)', 'data:text/html,hi', 'not a url'])(
        'renders %s as plain text, never a link',
        (href) => {
            renderUi(<ExternalChip href={href}>Lookup</ExternalChip>);
            expect(screen.getByText('Lookup')).toBeDefined();
            expect(screen.queryByRole('link')).toBeNull();
        },
    );
});

describe('SecurityNote', () => {
    it('explains in place on a soft surface instead of interrupting as an alert', () => {
        renderUi(<SecurityNote tone="warning">Clock is behind</SecurityNote>);
        expect(screen.getByText('Clock is behind').closest('.soft-surface')).not.toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
