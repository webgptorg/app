import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createFakeApiClient } from './api/fake-api-client';
import { App } from './app';

describe('app shell on an unknown deep link', () => {
    it('shows the not-found page with a way back, and ignores an unknown locale choice', async () => {
        window.history.pushState({}, '', '/engines/x');
        render(<App apiClient={createFakeApiClient(new Map())} />);
        expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();

        fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'xx' } });
        expect(document.documentElement.lang).toBe('en');

        fireEvent.click(screen.getByRole('link', { name: 'Back to the start' }));
        expect(await screen.findByRole('heading', { name: 'Your engines' })).toBeTruthy();
    });
});
