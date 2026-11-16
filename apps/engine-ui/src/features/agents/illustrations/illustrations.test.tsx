import { describe, expect, it } from 'vitest';

import { renderUi } from '../../../testing/render-ui';
import { AgentIllustration, ILLUSTRATION_IDS } from './illustrations';

/** The classes illustrations.css styles; a shape with any other class would draw unstyled (black fill). */
const STYLED = new Set([
    'art-body',
    'art-paper',
    'art-shade',
    'art-line',
    'art-thin',
    'art-thick',
    'art-ink',
    'art-cheek',
    'art-eye',
]);

describe('AgentIllustration', () => {
    it.each(ILLUSTRATION_IDS)('draws %s decoratively, styled only by classes its stylesheet styles', (id) => {
        const { container } = renderUi(<AgentIllustration id={id} className="size-8" />);
        const svg = container.querySelector('svg');
        expect(svg?.getAttribute('viewBox')).toBe('0 0 64 64');
        expect(svg?.getAttribute('aria-hidden')).toBe('true');
        expect(svg?.getAttribute('focusable')).toBe('false');
        expect(svg?.getAttribute('class')).toBe('agent-art size-8');
        const shapes = [...(svg?.children ?? [])];
        expect(shapes.length).toBeGreaterThan(4);
        for (const shape of shapes) {
            expect(shape.hasAttribute('style')).toBe(false);
            const classes = shape.getAttribute('class')?.split(' ') ?? [];
            expect(classes.length).toBeGreaterThan(0);
            for (const name of classes) expect(STYLED.has(name), name).toBe(true);
        }
    });

    it('marks every pair of eyes, so a blink can close them', () => {
        for (const id of ILLUSTRATION_IDS) {
            const { container } = renderUi(<AgentIllustration id={id} />);
            expect(container.querySelectorAll('.art-eye'), id).toHaveLength(2);
        }
    });
});
