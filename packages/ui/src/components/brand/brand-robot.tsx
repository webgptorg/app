import type { ReactNode } from 'react';

import { cx } from '../../internal/cx';

/**
 * The robot's poses. The kit publishes one pose as artwork (working); the others change only its pixel face, so the
 * figure itself stays exactly the kit's.
 */
export type RobotPose = 'working' | 'thinking' | 'assembling' | 'finished' | 'resting';

export type RobotSize = 'sm' | 'md' | 'lg';

const SIZES: Record<RobotSize, number> = { sm: 48, md: 72, lg: 112 };

const PIXEL = 0.0422;
const EYE = { width: PIXEL, height: 0.0842 };

/** Face pixels in the unit square of the display, `[x, y, width, height]`. */
type Pixel = readonly [number, number, number, number];

const SMILE: readonly Pixel[] = [
    [0.353, 0.553, PIXEL, PIXEL],
    [0.395, 0.595, PIXEL, PIXEL],
    [0.437, 0.637, 0.1262, PIXEL],
    [0.563, 0.595, PIXEL, PIXEL],
    [0.605, 0.553, PIXEL, PIXEL],
];
const OPEN_EYES: readonly Pixel[] = [
    [0.353, 0.385, EYE.width, EYE.height],
    [0.605, 0.385, EYE.width, EYE.height],
];

const FACES: Record<RobotPose, readonly Pixel[]> = {
    working: [...OPEN_EYES, ...SMILE],
    thinking: [
        [0.395, 0.343, EYE.width, EYE.height],
        [0.647, 0.343, EYE.width, EYE.height],
        [0.437, 0.595, 0.1684, PIXEL],
    ],
    assembling: [
        [0.353, 0.427, EYE.width, EYE.height],
        [0.605, 0.427, EYE.width, EYE.height],
        [0.437, 0.637, 0.1262, PIXEL],
    ],
    finished: [
        [0.311, 0.427, PIXEL, PIXEL],
        [0.353, 0.385, PIXEL, PIXEL],
        [0.395, 0.427, PIXEL, PIXEL],
        [0.563, 0.427, PIXEL, PIXEL],
        [0.605, 0.385, PIXEL, PIXEL],
        [0.647, 0.427, PIXEL, PIXEL],
        [0.311, 0.511, PIXEL, PIXEL],
        ...SMILE,
        [0.647, 0.511, PIXEL, PIXEL],
    ],
    resting: [
        [0.311, 0.448, 0.1262, PIXEL],
        [0.563, 0.448, 0.1262, PIXEL],
        [0.458, 0.616, 0.0842, PIXEL],
    ],
};

export interface BrandRobotProps {
    readonly pose?: RobotPose;
    readonly size?: RobotSize;
    readonly className?: string;
}

/**
 * The Promptbook robot from the brand kit: the voice of Promptbook itself (onboarding, empty lists, errors), never an
 * agent. Decorative: the words next to it carry the meaning.
 */
export function BrandRobot({ pose = 'working', size = 'md', className }: BrandRobotProps) {
    const edge = SIZES[size];
    return (
        <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 112 112"
            width={edge}
            height={edge}
            data-pose={pose}
            className={cx('shrink-0', className)}
        >
            <ellipse className="fill-(--brand-robot-ink) opacity-8" cx="56" cy="103" rx="34" ry="7" />
            <ellipse className="fill-(--brand-robot-ink) opacity-14" cx="44.6" cy="102" rx="9" ry="2.4" />
            <ellipse className="fill-(--brand-robot-ink) opacity-14" cx="67.4" cy="102" rx="9" ry="2.4" />
            <g className="stroke-(--brand-robot-ink)" strokeWidth=".55" strokeLinejoin="round">
                <polygon
                    className="fill-(--brand-robot-shell-1)"
                    points="35.6,98.11 44.57,103.29 44.57,92.93 35.6,87.74"
                />
                <polygon
                    className="fill-(--brand-robot-shell-2)"
                    points="35.6,87.74 44.57,92.93 53.55,87.74 44.57,82.56"
                />
                <polygon
                    className="fill-(--brand-robot-shell-1)"
                    points="58.45,98.11 67.43,103.29 67.43,92.93 58.45,87.74"
                />
                <polygon
                    className="fill-(--brand-robot-shell-2)"
                    points="58.45,87.74 67.43,92.93 76.4,87.74 67.43,82.56"
                />
                <polygon
                    className="fill-(--brand-robot-ink)"
                    points="44.57,103.29 53.55,98.11 53.55,87.74 44.57,92.93"
                />
                <polygon className="fill-(--brand-robot-ink)" points="67.43,103.29 76.4,98.11 76.4,87.74 67.43,92.93" />
                <polygon
                    className="fill-(--brand-robot-shell-3)"
                    points="45.25,59.61 20.59,73.85 25.64,76.77 50.3,62.53"
                />
                <polygon
                    className="fill-(--brand-robot-steel)"
                    points="50.3,62.53 25.64,76.77 25.64,87.53 30.69,84.62 30.69,79.68 50.3,68.36"
                />
                <polygon className="fill-(--brand-robot-sky)" points="24.51,85.2 26.48,85.9 28.52,84.58 26.55,83.88" />
                <polygon className="fill-(--brand-robot-steel)" points="25,87.48 26.97,88.18 26.48,85.9 24.51,85.2" />
                <polygon className="fill-(--brand-robot-ink)" points="26.97,88.18 29,86.86 28.52,84.58 26.48,85.9" />
                <polygon
                    className="fill-(--brand-robot-shell-4)"
                    points="20.59,73.85 20.59,84.62 25.64,87.53 25.64,76.77"
                />
                <polygon className="fill-(--brand-robot-shell-5)" points="56,99.52 76.4,87.74 76.4,64.18 56,75.96" />
                <polygon className="fill-(--brand-robot-shell-6)" points="35.6,64.18 56,75.96 76.4,64.18 56,52.4" />
                <polygon className="fill-(--brand-robot-shell-7)" points="35.6,87.74 56,99.52 56,75.96 35.6,64.18" />
                <polygon
                    className="fill-(--brand-robot-steel)"
                    points="22.18,74.23 24.15,74.93 22.84,68.78 20.87,68.08"
                />
                <polygon
                    className="fill-(--brand-robot-ink)"
                    points="24.15,74.93 26.19,73.61 24.88,67.46 22.84,68.78"
                />
                <polygon className="fill-(--brand-robot-sky)" points="20.87,68.08 22.84,68.78 24.88,67.46 22.9,66.76" />
                <polygon
                    className="fill-(--brand-robot-shell-3)"
                    points="20.59,66.78 22.57,67.48 24.6,66.17 22.63,65.47"
                />
                <polygon
                    className="fill-(--brand-robot-shell-4)"
                    points="20.87,68.08 22.84,68.78 22.57,67.48 20.59,66.78"
                />
                <polygon className="fill-(--brand-robot-sky)" points="22.84,68.78 24.88,67.46 24.6,66.17 22.57,67.48" />
                <polygon className="fill-(--brand-robot-shell-8)" points="20.59,66.78 22.57,67.48 21.92,63.3" />
                <polygon className="fill-(--brand-robot-sky)" points="22.57,67.48 24.6,66.17 21.92,63.3" />
                <polygon
                    className="fill-(--brand-robot-shell-3)"
                    points="39.32,80.1 59.74,79.29 60.23,83.41 39.8,84.22"
                />
                <polygon
                    className="fill-(--brand-robot-shell-4)"
                    points="32.19,86.21 32.19,77.02 32.68,81.13 32.68,90.33"
                />
                <polygon
                    className="fill-(--brand-robot-steel)"
                    points="60.23,89.24 32.68,90.33 32.68,81.13 39.8,80.85 39.8,84.22 60.23,83.41"
                />
                <polygon
                    className="fill-(--brand-robot-shell-3)"
                    points="32.19,77.02 39.32,76.74 39.8,80.85 32.68,81.13"
                />
                <polygon className="fill-(--brand-robot-ink)" points="56,83.24 89.01,64.18 89.01,26.06 56,45.12" />
                <polygon className="fill-(--brand-robot-white)" points="22.99,64.18 56,83.24 56,45.12 22.99,26.06" />
                <g transform="matrix(33.01 19.06 0 38.12 22.99 26.06)" stroke="none">
                    <rect className="fill-(--brand-robot-screen)" x=".16" y=".23" width=".68" height=".54" rx=".095" />
                    {FACES[pose].map(([x, y, width, height]) => (
                        <rect
                            key={`${String(x)} ${String(y)}`}
                            className="fill-(--brand-robot-white)"
                            x={x}
                            y={y}
                            width={width}
                            height={height}
                        />
                    ))}
                </g>
                <polygon className="fill-(--brand-robot-shell-9)" points="22.99,26.06 56,45.12 89.01,26.06 56,7" />
                <polygon className="fill-(--brand-robot-ink)" points="56,7 22.99,26.06 56,26.06" stroke="none" />
            </g>
        </svg>
    );
}

export interface RobotGuideProps {
    /** One short line in Promptbook's voice: what this is, or the next step. */
    readonly children: ReactNode;
    readonly pose?: RobotPose;
    readonly size?: RobotSize;
    /** The one next step, e.g. a button. */
    readonly action?: ReactNode;
    /** `row` puts the bubble beside the robot; `stack` puts it below, centred. */
    readonly layout?: 'row' | 'stack';
    readonly className?: string;
}

/** The robot with a speech bubble: Promptbook guiding the user one calm line at a time. */
export function RobotGuide({
    children,
    pose = 'working',
    size = 'md',
    action,
    layout = 'row',
    className,
}: RobotGuideProps) {
    const stacked = layout === 'stack';
    return (
        <div className={cx('flex gap-3', stacked ? 'flex-col items-center text-center' : 'items-center', className)}>
            <BrandRobot pose={pose} size={size} />
            <div className={cx('flex min-w-0 flex-col gap-2', stacked ? 'items-center' : 'items-start')}>
                <p
                    className={cx(
                        'relative max-w-prose rounded-surface bg-(--brand-guide-bubble) px-3 py-2 text-sm text-(--brand-guide-text)',
                        stacked
                            ? 'before:absolute before:-top-1.5 before:left-1/2 before:size-3 before:-translate-x-1/2 before:rotate-45 before:bg-(--brand-guide-bubble)'
                            : 'before:absolute before:top-1/2 before:-left-1.5 before:size-3 before:-translate-y-1/2 before:rotate-45 before:bg-(--brand-guide-bubble)',
                    )}
                >
                    <span className="relative">{children}</span>
                </p>
                {action === undefined ? null : <div>{action}</div>}
            </div>
        </div>
    );
}
