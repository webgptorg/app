import { describe, expect, it } from 'vitest';

import { safeTint, tintStyle } from '../../theme/tint';
import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Avatar } from './avatar';

describe('Avatar', () => {
    it.each(['light', 'dark'] as const)('draws the initial as generated content on its tint (%s)', async (theme) => {
        const { container } = renderUi(
            <p>
                <Avatar name="  šárka" tint="var(--color-agent-3)" size="md" />
                {'Šárka'}
            </p>,
            { theme },
        );
        const avatar = container.querySelector('span');
        expect(avatar?.dataset['initial']).toBe('Š');
        expect(avatar?.textContent).toBe('');
        expect(avatar?.getAttribute('aria-hidden')).toBe('true');
        expect(avatar?.style.getPropertyValue('--tint')).toBe('var(--color-agent-3)');
        await expectNoAxeViolations(container);
    });

    it('shows a picture when it has one, and ignores a tint it cannot trust', () => {
        const { container } = renderUi(
            <>
                <Avatar name="Ada" src="https://engine.example/ada.png" size="lg" />
                <Avatar name="Max" tint="url(https://evil.example)" size="2xs" />
                <Avatar name="" src="" />
            </>,
        );
        expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
        const spans = container.querySelectorAll('span');
        expect(spans[0]?.getAttribute('style')).toBeNull();
        expect(spans[1]?.dataset['initial']).toBe('');
    });
});

describe('tint', () => {
    it('passes only hex colours and our colour tokens', () => {
        expect(safeTint('#12abEF')).toBe('#12abEF');
        expect(safeTint('var(--color-agent-1)')).toBe('var(--color-agent-1)');
        for (const value of ['#fff', 'red', 'url(x)', 'var(--x)', 'var(--color-a); color: red', null, undefined]) {
            expect(safeTint(value)).toBeUndefined();
        }
        expect(tintStyle('#000000')).toEqual({ '--tint': '#000000' });
        expect(tintStyle('blue')).toBeUndefined();
    });
});
