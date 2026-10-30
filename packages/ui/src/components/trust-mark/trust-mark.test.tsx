import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { REDUCED_MOTION, setMedia } from '../../testing/dom-gaps';
import { renderUi } from '../../testing/render';
import { UiProvider } from '../../i18n/ui-provider';
import { TEST_MESSAGES } from '../../testing/test-messages';
import { SAMPLE_FINGERPRINTS } from './sample-fingerprints';
import { TrustMark } from './trust-mark';

const FINGERPRINT = SAMPLE_FINGERPRINTS.lead;
const SAMPLES = Object.values(SAMPLE_FINGERPRINTS);
const SEALING = 'trust-mark-sealing';

function seal(container: HTMLElement): SVGElement {
    const svg = container.querySelector('svg');
    if (svg === null) throw new Error('no seal');
    return svg;
}

describe('TrustMark', () => {
    it.each(SAMPLES)('names and shows the fingerprint code $formatted', (fingerprint) => {
        renderUi(<TrustMark fingerprint={fingerprint} state="verified" />);
        const mark = screen.getByRole('img');
        expect(mark.getAttribute('aria-label')).toBe(
            `Private engine verified, Engine fingerprint ${fingerprint.formatted}`,
        );
        // The mark wraps the code under the seal before the code itself breaks.
        const code = mark.querySelector('.font-mono');
        if (code === null) throw new Error('the code as text');
        expect(code.textContent).toBe(fingerprint.formatted);
        // Line breaks only between groups: each group is one unbreakable span, and together they are the exact code.
        const groups = [...code.children];
        expect(groups.map((group) => group.textContent).join('')).toBe(fingerprint.formatted);
        expect(groups.map((group) => group.textContent.replace(/-$/u, ''))).toEqual(fingerprint.formatted.split('-'));
        for (const group of groups) expect(group.className).toContain('whitespace-nowrap');
        expect(mark.className).toContain('flex-wrap');
        expect(mark.querySelector('[data-fingerprint]')?.getAttribute('data-fingerprint')).toBe(
            fingerprint.patternBits,
        );
    });

    it.each(SAMPLES)('draws exactly the filled cells of $formatted', (fingerprint) => {
        const { container } = renderUi(<TrustMark fingerprint={fingerprint} state="verified" />);
        // The 5×5 grid of 5-unit cells with 1-unit gaps, centred in the 64-unit seal.
        const index = (offset: string | null) => (Number(offset) - 17.5) / 6;
        const drawn = [...container.querySelectorAll('[data-fingerprint] rect')].map(
            (cell) => `${String(index(cell.getAttribute('y')))},${String(index(cell.getAttribute('x')))}`,
        );
        const filled = fingerprint.cells.flatMap((row, rowIndex) =>
            row.flatMap((isFilled, columnIndex) => (isFilled ? [`${String(rowIndex)},${String(columnIndex)}`] : [])),
        );
        expect(drawn).toEqual(filled);
    });

    it('renders the same pattern for the same fingerprint and a different one for another', () => {
        const a = renderUi(<TrustMark fingerprint={FINGERPRINT} state="verified" />);
        const b = renderUi(<TrustMark fingerprint={FINGERPRINT} state="verifying" size="lg" />);
        const c = renderUi(<TrustMark fingerprint={SAMPLE_FINGERPRINTS.lab} state="verified" />);
        const pattern = (container: HTMLElement) =>
            [...container.querySelectorAll('[data-fingerprint] rect')].map((cell) =>
                ['x', 'y', 'class'].map((name) => cell.getAttribute(name)).join(' '),
            );
        expect(pattern(a.container)).toEqual(pattern(b.container));
        expect(pattern(a.container)).not.toEqual(pattern(c.container));
        expect(a.container.querySelectorAll('rect').length).toBeGreaterThan(0);
    });

    it('renders the seal without a fingerprint while the engine ID is unknown', () => {
        const { container } = renderUi(<TrustMark fingerprint={null} state="verifying" />);
        expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Verifying engine');
        expect(container.querySelector('[data-fingerprint]')).toBeNull();
        expect(container.querySelector('.font-mono')).toBeNull();
    });

    it('takes a custom label and can hide the code text but not from the accessible name', () => {
        renderUi(
            <TrustMark fingerprint={FINGERPRINT} state="verified" label="Lead engine" showCode={false} size="sm" />,
        );
        expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
            `Lead engine, Engine fingerprint ${FINGERPRINT.formatted}`,
        );
        expect(screen.getByRole('img').textContent).toBe('');
    });

    it('plays the seal animation on verifying → verified only, and replays it after verifying again', () => {
        const ui = (state: 'verifying' | 'verified') => (
            <UiProvider messages={TEST_MESSAGES} locale="en">
                <TrustMark fingerprint={FINGERPRINT} state={state} />
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
                <TrustMark fingerprint={FINGERPRINT} state={state} />
            </UiProvider>
        );
        const { container, rerender } = render(ui('verifying'));
        rerender(ui('verified'));
        expect(seal(container).classList.contains(SEALING)).toBe(false);
    });

    it('drops a running seal animation when reduced motion is switched on', () => {
        const ui = (state: 'verifying' | 'verified') => (
            <UiProvider messages={TEST_MESSAGES} locale="en">
                <TrustMark fingerprint={FINGERPRINT} state={state} />
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
                <TrustMark fingerprint={FINGERPRINT} state="verified" />
                <TrustMark fingerprint={null} state="verifying" size="sm" />
            </div>,
            { theme },
        );
        await expectNoAxeViolations(container);
    });
});
