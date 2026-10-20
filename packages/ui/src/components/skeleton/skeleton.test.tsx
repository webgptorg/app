import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Skeleton } from './skeleton';

describe('Skeleton', () => {
    it.each(['light', 'dark'] as const)(
        'is hidden from assistive technology and never focusable (%s)',
        async (theme) => {
            const { container, user } = renderUi(
                <div aria-busy="true">
                    <Skeleton />
                    <Skeleton shape="block" />
                    <Skeleton shape="circle" className="size-8" />
                </div>,
                { theme },
            );
            const placeholders = container.querySelectorAll('[aria-hidden="true"]');
            expect(placeholders).toHaveLength(3);
            await user.tab();
            expect(document.activeElement).toBe(document.body);
            expect(placeholders[2]?.className).toContain('size-8');
            expect(placeholders[0]?.className).toContain('motion-safe:animate-');
            await expectNoAxeViolations(container);
        },
    );
});
