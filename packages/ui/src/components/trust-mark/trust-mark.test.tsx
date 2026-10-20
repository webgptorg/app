import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { REDUCED_MOTION, setMedia } from '../../testing/dom-gaps';
import { renderUi } from '../../testing/render';
import { UiProvider } from '../../i18n/ui-provider';
import { TEST_MESSAGES } from '../../testing/test-messages';
import vectorFile from './fingerprint-vectors.json';
import { TrustMark } from './trust-mark';

const [first, second] = vectorFile.vectors;
const ENGINE_ID = first?.engineId ?? '';
const SEALING = 'trust-mark-sealing';

function seal(container: HTMLElement): SVGElement {
    const svg = container.querySelector('svg');
    if (svg === null) throw new Error('no seal');
    return svg;
}

describe('TrustMark', () => {
    it.each(vectorFile.vectors)('names and shows the fingerprint code of $engineId', (vector) => {
        renderUi(<TrustMark engineId={vector.engineId} state="verified" />);
        const mark = screen.getByRole('img');
        expect(mark.getAttribute('aria-label')).toBe(`Private engine verified, Engine fingerprint ${vector.formatted}`);
        expect(screen.getByText(vector.formatted)).toBeDefined();
        expect(mark.querySelector('[data-fingerprint]')?.getAttribute('data-fingerprint')).toBe(vector.patternBits);
    });

    it('renders the same pattern for the same engine ID and a different one for another', () => {
        const a = renderUi(<TrustMark engineId={ENGINE_ID} state="verified" />);
        const b = renderUi(<TrustMark engineId={ENGINE_ID} state="verifying" size="lg" />);
        const c = renderUi(<TrustMark engineId={second?.engineId ?? ''} state="verified" />);
        const pattern = (container: HTMLElement) =>
            [...container.querySelectorAll('[data-fingerprint] rect')].map((cell) =>
                ['x', 'y', 'class'].map((name) => cell.getAttribute(name)).join(' '),
            );
        expect(pattern(a.container)).toEqual(pattern(b.container));
        expect(pattern(a.container)).not.toEqual(pattern(c.container));
        expect(a.container.querySelectorAll('rect').length).toBeGreaterThan(0);
    });

    it('renders the seal without a fingerprint while the engine ID is unknown', () => {
        const { container } = renderUi(<TrustMark engineId={null} state="verifying" />);
        expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Verifying engine');
        expect(container.querySelector('[data-fingerprint]')).toBeNull();
        expect(container.querySelector('.font-mono')).toBeNull();
    });

    it('takes a custom label and can hide the code text but not from the accessible name', () => {
        renderUi(<TrustMark engineId={ENGINE_ID} state="verified" label="Lead engine" showCode={false} size="sm" />);
        expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
            `Lead engine, Engine fingerprint ${first?.formatted ?? ''}`,
        );
        expect(screen.queryByText(first?.formatted ?? '')).toBeNull();
    });

    it('plays the seal animation on verifying → verified only, and replays it after verifying again', () => {
        const ui = (state: 'verifying' | 'verified') => (
            <UiProvider messages={TEST_MESSAGES} locale="en">
                <TrustMark engineId={ENGINE_ID} state={state} />
            </UiProvider>
        );
        const { container, rerender } = render(ui('verified'));
        expect(seal(container).classList.contains(SEALING)).toBe(false);

        rerender(ui('verifying'));
        expect(seal(container).classList.contains(SEALING)).toBe(false);
        rerender(ui('verified'));
        expect(seal(container).classList.contains(SEALING)).toBe(true);
        rerender(ui('verified'));
        expect(seal(container).classList.contains(SEALING)).toBe(true);

        rerender(ui('verifying'));
        expect(seal(container).classList.contains(SEALING)).toBe(false);
    });

    it('never adds the seal animation under reduced motion', () => {
        setMedia(REDUCED_MOTION, true);
        const ui = (state: 'verifying' | 'verified') => (
            <UiProvider messages={TEST_MESSAGES} locale="en">
                <TrustMark engineId={ENGINE_ID} state={state} />
            </UiProvider>
        );
        const { container, rerender } = render(ui('verifying'));
        rerender(ui('verified'));
        expect(seal(container).classList.contains(SEALING)).toBe(false);
    });

    it('drops a running seal animation when reduced motion is switched on', () => {
        const ui = (state: 'verifying' | 'verified') => (
            <UiProvider messages={TEST_MESSAGES} locale="en">
                <TrustMark engineId={ENGINE_ID} state={state} />
            </UiProvider>
        );
        const { container, rerender } = render(ui('verifying'));
        rerender(ui('verified'));
        expect(seal(container).classList.contains(SEALING)).toBe(true);
        act(() => {
            setMedia(REDUCED_MOTION, true);
        });
        expect(seal(container).classList.contains(SEALING)).toBe(false);
    });

    it.each(['light', 'dark'] as const)('has no axe violations (%s)', async (theme) => {
        const { container } = renderUi(
            <div>
                <TrustMark engineId={ENGINE_ID} state="verified" />
                <TrustMark engineId={null} state="verifying" size="sm" />
            </div>,
            { theme },
        );
        await expectNoAxeViolations(container);
    });
});
