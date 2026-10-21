import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../../testing/render-ui';
import { CodeBlock } from './code-block';

vi.mock('./highlight', () => ({
    highlightLines: () => Promise.reject(new Error('chunk failed to load')),
}));

describe('CodeBlock when a grammar fails to load', () => {
    it('keeps the code plain', async () => {
        const { container } = renderUi(<CodeBlock code="const a = 1;" lang="ts" />);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(container.querySelector('code')?.textContent).toBe('const a = 1;');
        expect(container.querySelector('[class*="tok-"]')).toBeNull();
    });
});
