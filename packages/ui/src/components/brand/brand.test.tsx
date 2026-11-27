import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { BRAND_LOCKUP_MIN_WIDTH, BRAND_MARK_MIN_SIZE, BrandLockup, BrandMark } from './brand-mark';
import { BrandRobot, RobotGuide } from './brand-robot';
import type { RobotPose } from './brand-robot';

describe('BrandMark and BrandLockup', () => {
    it.each(['light', 'dark'] as const)('are named Promptbook and pass axe (%s)', async (theme) => {
        const { container } = renderUi(
            <>
                <BrandMark />
                <BrandLockup />
            </>,
            { theme },
        );
        expect(screen.getAllByRole('img', { name: 'Promptbook' })).toHaveLength(2);
        await expectNoAxeViolations(container);
    });

    it('never goes below the kit minimum sizes', () => {
        const { container } = render(
            <>
                <BrandMark size={12} />
                <BrandLockup width={80} />
            </>,
        );
        const [mark, lockup] = container.querySelectorAll('svg');
        expect(mark?.getAttribute('width')).toBe(String(BRAND_MARK_MIN_SIZE));
        expect(lockup?.getAttribute('width')).toBe(String(BRAND_LOCKUP_MIN_WIDTH));
    });

    it('keeps the aspect ratio and a quarter of the symbol height clear', () => {
        const { container } = render(
            <>
                <BrandMark size={64} />
                <BrandLockup width={380} />
            </>,
        );
        const [mark, lockup] = container.querySelectorAll('svg');
        expect(mark?.style.margin).toBe('16px');
        expect(Number(lockup?.getAttribute('height'))).toBeCloseTo(82, 5);
        expect(Number.parseFloat(lockup?.style.margin ?? '')).toBeCloseTo((82 * 155.2) / 164 / 4, 3);
    });

    it('hides itself when decorative', () => {
        const { container } = render(<BrandMark decorative />);
        expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('draws only paths, with no script, links or embedded content', () => {
        const { container } = render(
            <>
                <BrandMark />
                <BrandLockup />
                <BrandRobot />
            </>,
        );
        const tags = new Set([...container.querySelectorAll('svg *')].map((element) => element.tagName));
        expect([...tags].sort()).toEqual(['ellipse', 'g', 'path', 'polygon', 'rect']);
        const attributes = [...container.querySelectorAll('svg, svg *')].flatMap((element) =>
            element.getAttributeNames(),
        );
        expect(attributes.filter((name) => /^on|href$/i.test(name))).toEqual([]);
    });
});

describe('BrandRobot', () => {
    it.each(['working', 'thinking', 'assembling', 'finished', 'resting'] satisfies RobotPose[])(
        'draws the %s pose as decoration',
        (pose) => {
            const { container } = render(<BrandRobot pose={pose} size="sm" />);
            const svg = container.querySelector('svg');
            expect(svg?.getAttribute('aria-hidden')).toBe('true');
            expect(svg?.getAttribute('data-pose')).toBe(pose);
            expect(svg?.getAttribute('width')).toBe('48');
        },
    );
});

describe('RobotGuide', () => {
    it.each(['light', 'dark'] as const)('says its line and offers one action (%s)', async (theme) => {
        const { container, user } = renderUi(
            <RobotGuide action={<button type="button">{'Create an agent'}</button>}>
                {'Start with one agent.'}
            </RobotGuide>,
            { theme },
        );
        expect(screen.getByText('Start with one agent.')).toBeDefined();
        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create an agent' }));
        await expectNoAxeViolations(container);
    });

    it('stacks the bubble under the robot', () => {
        const { container } = render(<RobotGuide layout="stack">{'All set.'}</RobotGuide>);
        expect(container.firstElementChild?.className).toMatch(/flex-col/);
        expect(container.querySelector('button')).toBeNull();
    });
});
