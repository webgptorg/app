import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderUi } from '../../testing/render-ui';
import { ReleaseLogEntry } from './release-log-entry';

describe('ReleaseLogEntry', () => {
    it('says so when the engine reports no log entry', () => {
        renderUi(<ReleaseLogEntry logIndex={null} entryUuid={null} />);
        expect(screen.getByText('No log entry reported')).toBeDefined();
    });

    it('shows the index with a public Rekor lookup when only the index is known', () => {
        renderUi(<ReleaseLogEntry logIndex={123456} entryUuid={null} />);
        expect(screen.getByRole('link', { name: /Look it up in Rekor/ }).getAttribute('href')).toBe(
            'https://search.sigstore.dev/?logIndex=123456',
        );
        expect(screen.queryByText('Entry UUID')).toBeNull();
    });

    it('shows the UUID without a lookup when only the UUID is known', () => {
        renderUi(<ReleaseLogEntry logIndex={null} entryUuid={'c'.repeat(64)} />);
        expect(screen.getByText('Entry UUID')).toBeDefined();
        expect(screen.queryByText('Log index')).toBeNull();
        expect(screen.queryByRole('link')).toBeNull();
    });

    it('offers the Rekor lookup as a link out that cannot reach back into this page', () => {
        renderUi(<ReleaseLogEntry logIndex={7} entryUuid={null} />);
        const link = screen.getByRole('link', { name: /Look it up in Rekor/ });
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('keeps the whole UUID on one quiet line, copyable, instead of a slab of groups', () => {
        const uuid = 'ab'.repeat(40);
        renderUi(<ReleaseLogEntry logIndex={null} entryUuid={uuid} />);
        const value = screen.getByText(uuid);
        expect(value.tagName).toBe('CODE');
        expect(value.getAttribute('title')).toBe(uuid);
        expect(value.className).toContain('truncate');
        expect(screen.getByRole('button', { name: 'Copy entry UUID' })).toBeDefined();
    });
});
