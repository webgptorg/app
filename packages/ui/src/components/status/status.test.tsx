import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { StatusDot, StatusPill } from './status';
import type { StatusTone } from './status';

const TONES: readonly StatusTone[] = ['live', 'waiting', 'success', 'warning', 'danger', 'info', 'neutral'];

describe('StatusPill', () => {
    it.each(['light', 'dark'] as const)('says the state in words beside a decorative dot (%s)', async (theme) => {
        const { container } = renderUi(
            <p>
                {TONES.map((tone) => (
                    <StatusPill key={tone} tone={tone}>
                        {tone}
                    </StatusPill>
                ))}
            </p>,
            { theme },
        );
        for (const tone of TONES) expect(screen.getByText(tone)).toBeDefined();
        expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(TONES.length);
        await expectNoAxeViolations(container);
    });

    it('tints its wash by tone, and drops it when quiet', () => {
        renderUi(
            <>
                <StatusPill tone="danger">{'Failed'}</StatusPill>
                <StatusPill tone="success" variant="quiet">
                    {'Done'}
                </StatusPill>
            </>,
        );
        const failed = screen.getByText('Failed').parentElement;
        expect(failed?.className).toMatch(/--tint:var\(--status-danger\)/);
        expect(failed?.className).toMatch(/px-2/);
        expect(screen.getByText('Done').parentElement?.className).not.toMatch(/px-2/);
    });
});

describe('StatusDot', () => {
    it('is hidden without a label and an image with one', () => {
        const { container } = renderUi(
            <>
                <StatusDot tone="live" />
                <StatusDot tone="waiting" label="Queued" />
            </>,
        );
        expect(container.querySelector('[aria-hidden="true"]')?.className).toMatch(/animate-breathe/);
        expect(screen.getByRole('img', { name: 'Queued' }).className).toMatch(/border-/);
    });
});
