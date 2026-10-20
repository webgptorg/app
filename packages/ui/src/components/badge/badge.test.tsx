import { screen } from '@testing-library/react';
import { Check } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Badge } from './badge';
import type { BadgeTone } from './badge';

const TONES: readonly BadgeTone[] = ['neutral', 'accent', 'success', 'warning', 'danger', 'info'];

describe('Badge', () => {
    it.each(['light', 'dark'] as const)('always carries text, with decorative icons only (%s)', async (theme) => {
        const { container } = renderUi(
            <p>
                {TONES.map((tone) => (
                    <Badge key={tone} tone={tone} icon={<Check />}>
                        {tone}
                    </Badge>
                ))}
            </p>,
            { theme },
        );
        for (const tone of TONES) expect(screen.getByText(tone)).toBeDefined();
        expect(container.querySelectorAll('[aria-hidden="true"] svg')).toHaveLength(TONES.length);
        expect(container.querySelector('[tabindex]')).toBeNull();
        await expectNoAxeViolations(container);
    });

    it('defaults to neutral without an icon', () => {
        const { container } = renderUi(<Badge className="x">{'Draft'}</Badge>);
        expect(container.querySelector('svg')).toBeNull();
        expect(container.firstElementChild?.className).toContain('--badge-neutral-bg');
    });
});
