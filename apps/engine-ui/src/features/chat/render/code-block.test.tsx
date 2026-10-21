import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../../testing/axe';
import { renderUi } from '../../../testing/render-ui';
import { CodeBlock } from './code-block';

afterEach(() => {
    vi.restoreAllMocks();
});

/** Lets the grammar's dynamic import and the highlight settle. */
async function settle() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('CodeBlock', () => {
    it('highlights a TypeScript block into token spans, keeping the exact text', async () => {
        const code = "const status: string = await check('x');\nconsole.log(status);";
        const { container } = renderUi(<CodeBlock code={code} lang="ts" />);
        expect(container.querySelector('code')?.textContent).toBe(code);
        await waitFor(() => {
            expect(container.querySelector('code .tok-keyword')).not.toBeNull();
        });
        expect(container.querySelector('code .tok-typeName')?.textContent).toBe('string');
        expect(container.querySelector('code')?.textContent).toBe(code);
        expect(screen.getByText('ts')).toBeDefined();
        await expectNoAxeViolations(container);
    });

    it.each([
        ['an unknown language', 'brainfuck'],
        ['no language', null],
    ])('renders %s as plain text', async (_, lang) => {
        const { container } = renderUi(<CodeBlock code={'++[>+<-]'} lang={lang} />);
        await settle();
        expect(container.querySelector('code')?.textContent).toBe('++[>+<-]');
        expect(container.querySelector('[class*="tok-"]')).toBeNull();
    });

    it('copies exactly the code, whitespace included', async () => {
        const user = userEvent.setup();
        const writeText = vi.fn(() => Promise.resolve());
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        const code = '  indented  \n\ttabbed\n\n';
        renderUi(<CodeBlock code={code} lang="sh" />);
        await user.click(screen.getByRole('button', { name: 'Copy code' }));
        expect(writeText).toHaveBeenCalledExactlyOnceWith(code);
        expect(await screen.findByText('Copied')).toBeDefined();
    });

    it('shows new code plain until it is highlighted, never the previous highlight', async () => {
        const { container, rerender } = renderUi(<CodeBlock code="SELECT 1" lang="sql" />);
        await waitFor(() => {
            expect(container.querySelector('.tok-keyword')).not.toBeNull();
        });
        rerender(<CodeBlock code="SELECT 2" lang="sql" />);
        expect(container.querySelector('code')?.textContent).toBe('SELECT 2');
        await waitFor(() => {
            expect(container.querySelector('.tok-number')?.textContent).toBe('2');
        });
    });

    it('drops a highlight that arrives after the block is gone', async () => {
        const { unmount } = renderUi(<CodeBlock code="echo hi" lang="bash" />);
        unmount();
        await settle();
        expect(document.querySelector('code')).toBeNull();
    });
});
