import { renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createAppQueryClient } from '../query-client';
import { BrowserProvider, useBrowser } from '../browser-context';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createTestEngineApi } from '../../testing/test-engine-api';
import { FEATURES } from '../features';
import { defineFeature } from './feature';
import { firstNavPath } from './first-nav-path';
import { requireFeature } from './require-feature';

const context = (features = FEATURES) => ({
    queryClient: createAppQueryClient({ onUnauthenticated: () => undefined }),
    engineApi: createTestEngineApi(),
    features,
});

describe('registry guards', () => {
    it('refuse a route guarded by a feature that is not registered', async () => {
        await expect(requireFeature('nowhere')({ context: context() })).rejects.toThrow(/no feature "nowhere"/);
    });

    it('fall back to Settings when no feature has a sidebar entry', async () => {
        const headless = defineFeature({ id: 'headless', requires: {} });
        await expect(firstNavPath(context([headless]))).resolves.toBe('/settings');
    });

    it('answer "not found" for the gallery outside the test:csp build', async () => {
        renderWithProviders({ path: '/__gallery' });
        expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeDefined();
    });

    it.each([
        ['/audit', 'Audit log'],
        ['/secrets', 'Secrets'],
        ['/security', 'Security'],
    ])('render the stub of %s for a member with its permission', async (path, title) => {
        renderWithProviders({ path });
        expect(await screen.findByRole('heading', { level: 1, name: title })).toBeDefined();
    });

    it('need the browser APIs from the composition root', () => {
        expect(() => renderHook(() => useBrowser())).toThrow(/BrowserProvider/);
        expect(BrowserProvider).toBeTypeOf('function');
    });
});
