import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Monogram } from './monogram';

describe('Monogram', () => {
    it('draws the initial without adding text to the control around it', async () => {
        const { container, getByRole } = renderUi(
            <button type="button" aria-label="Account menu for ada@example.com">
                <Monogram name=" ada@example.com" />
                <span>ada@example.com</span>
            </button>,
        );
        const monogram = container.querySelector('[data-initial]');
        expect(monogram?.getAttribute('data-initial')).toBe('A');
        expect(monogram?.getAttribute('aria-hidden')).toBe('true');
        expect(monogram?.textContent).toBe('');
        expect(getByRole('button').textContent).toBe('ada@example.com');
        await expectNoAxeViolations(container);
    });

    it('draws nothing for an empty name', () => {
        const { container } = renderUi(<Monogram name="  " />);
        expect(container.querySelector('[data-initial]')?.getAttribute('data-initial')).toBe('');
    });
});
