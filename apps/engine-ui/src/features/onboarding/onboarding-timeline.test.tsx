import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SetupProgressBar, SetupTimeline } from './onboarding-timeline';
import { spoken } from '../../testing/spoken';

const steps = () => within(screen.getByRole('list', { name: 'Setup steps' })).getAllByRole('listitem');

describe('SetupTimeline', () => {
    it('marks the current step and names only the steps this visit has seen up to it', () => {
        const titles = new Map([
            [1, 'Your project'],
            [3, 'Sign in to OpenAI Codex'],
            [4, 'Project name'],
        ]);
        render(<SetupTimeline progress={{ step: 3, of: 5 }} titles={titles} />);
        expect(steps().map(spoken)).toEqual([
            'Your project(done)',
            'Step 2(done)',
            'Sign in to OpenAI Codex',
            // Seen before Back, but the engine may branch: a step ahead is never named.
            'Step 4',
            'Step 5',
        ]);
        expect(steps().map((step) => step.getAttribute('aria-current'))).toEqual([null, null, 'step', null, null]);
    });

    it('says only "Step x of y" for a count it cannot draw', () => {
        const { rerender } = render(<SetupTimeline progress={{ step: 2, of: 40 }} titles={new Map()} />);
        expect(screen.queryByRole('list')).toBeNull();
        expect(screen.getByText('Step 2 of 40')).toBeDefined();
        rerender(<SetupTimeline progress={{ step: 7, of: 6 }} titles={new Map()} />);
        expect(screen.queryByRole('list')).toBeNull();
        expect(screen.getByText('Step 7 of 6')).toBeDefined();
    });
});

describe('SetupProgressBar', () => {
    it('draws a segment per step under the words, and only the words for a count it cannot draw', () => {
        const { container, rerender } = render(<SetupProgressBar progress={{ step: 2, of: 6 }} />);
        expect(screen.getByText('Step 2 of 6')).toBeDefined();
        expect(container.querySelectorAll('[aria-hidden] > span')).toHaveLength(6);
        rerender(<SetupProgressBar progress={{ step: 2, of: 400 }} />);
        expect(container.querySelectorAll('[aria-hidden] > span')).toHaveLength(0);
    });
});
