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
});
