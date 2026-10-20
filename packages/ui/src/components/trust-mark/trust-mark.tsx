import { useMemo, useState } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';
import { useReducedMotion } from '../../motion/reduced-motion';
import { deriveEngineFingerprint, FINGERPRINT_GRID_SIZE, fingerprintColour } from './fingerprint';

export type TrustMarkState = 'verifying' | 'verified';
export type TrustMarkSize = 'sm' | 'md' | 'lg';

export interface TrustMarkProps {
    /** `null` until the engine reports its ID; the seal then renders without a fingerprint. */
    readonly engineId: string | null;
    readonly state: TrustMarkState;
    readonly size?: TrustMarkSize;
    /** Replaces the state's default accessible name; the fingerprint code is always appended. */
    readonly label?: string;
    /** Renders the code as text next to the seal; the pattern is never its only carrier. */
    readonly showCode?: boolean;
    readonly className?: string;
}

const VIEWBOX = 64;
const CENTRE = VIEWBOX / 2;
const LOBES = 12;
const INNER_RADIUS = 27;
const OUTER_RADIUS = 31;
const CELL = 5;
const GAP = 1;
const GRID_ORIGIN = (VIEWBOX - (FINGERPRINT_GRID_SIZE * CELL + (FINGERPRINT_GRID_SIZE - 1) * GAP)) / 2;

const round = (value: number) => Math.round(value * 100) / 100;
const point = (radius: number, angle: number) =>
    `${String(round(CENTRE + radius * Math.cos(angle)))} ${String(round(CENTRE + radius * Math.sin(angle)))}`;

/** A scalloped rosette: the Promptbook seal's outline, a stamp rather than a padlock. */
const ROSETTE_PATH = (() => {
    const step = (2 * Math.PI) / LOBES;
    let path = `M ${point(INNER_RADIUS, -Math.PI / 2)}`;
    for (let lobe = 0; lobe < LOBES; lobe += 1) {
        const start = -Math.PI / 2 + lobe * step;
        path += ` Q ${point(OUTER_RADIUS, start + step / 2)} ${point(INNER_RADIUS, start + step)}`;
    }
    return `${path} Z`;
})();

const FP_FILL = [
    'fill-(--trust-mark-fp-1)',
    'fill-(--trust-mark-fp-2)',
    'fill-(--trust-mark-fp-3)',
    'fill-(--trust-mark-fp-4)',
    'fill-(--trust-mark-fp-5)',
    'fill-(--trust-mark-fp-6)',
] as const;

const SIZE_CLASSES: Readonly<Record<TrustMarkSize, { readonly seal: string; readonly code: string }>> = {
    sm: { seal: 'size-6', code: 'text-xs' },
    md: { seal: 'size-10', code: 'text-sm' },
    lg: { seal: 'size-20', code: 'text-base' },
};

/**
 * The Promptbook seal with the engine fingerprint (docs/design/ui.md, Trust mark). Moving from `verifying` to
 * `verified` draws the seal once; it never animates on first render or under reduced motion.
 */
export function TrustMark({ engineId, state, size = 'md', label, showCode = true, className }: TrustMarkProps) {
    const messages = useUiMessages();
    const reducedMotion = useReducedMotion();
    const fingerprint = useMemo(() => (engineId === null ? null : deriveEngineFingerprint(engineId)), [engineId]);
    const [previousState, setPreviousState] = useState(state);
    const [sealing, setSealing] = useState(false);
    if (previousState !== state) {
        setPreviousState(state);
        setSealing(previousState === 'verifying' && state === 'verified');
    }

    const name = label ?? (state === 'verified' ? messages.trustMarkVerified() : messages.trustMarkVerifying());
    const accessibleName =
        fingerprint === null ? name : `${name}, ${messages.trustMarkFingerprint({ code: fingerprint.formatted })}`;
    const sizes = SIZE_CLASSES[size];

    return (
        <span role="img" aria-label={accessibleName} className={cx('inline-flex items-center gap-2', className)}>
            <svg
                viewBox={`0 0 ${String(VIEWBOX)} ${String(VIEWBOX)}`}
                aria-hidden="true"
                data-state={state}
                className={cx('shrink-0', sizes.seal, sealing && !reducedMotion && 'trust-mark-sealing')}
            >
                <path
                    d={ROSETTE_PATH}
                    pathLength={100}
                    strokeWidth={2.5}
                    strokeLinejoin="round"
                    className={cx(
                        'trust-mark-outline fill-(--trust-mark-surface)',
                        state === 'verified' ? 'stroke-(--trust-mark-seal)' : 'stroke-(--trust-mark-seal-verifying)',
                    )}
                />
                {fingerprint === null ? (
                    <path
                        d="M 22 33 L 29 40 L 43 25"
                        fill="none"
                        strokeWidth={4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={
                            state === 'verified' ? 'stroke-(--trust-mark-seal)' : 'stroke-(--trust-mark-seal-verifying)'
                        }
                    />
                ) : (
                    <g data-fingerprint={fingerprint.patternBits}>
                        {fingerprint.cells.flatMap((row, rowIndex) =>
                            row.map((filled, columnIndex) =>
                                filled ? (
                                    <rect
                                        key={`${String(rowIndex)}-${String(columnIndex)}`}
                                        x={GRID_ORIGIN + columnIndex * (CELL + GAP)}
                                        y={GRID_ORIGIN + rowIndex * (CELL + GAP)}
                                        width={CELL}
                                        height={CELL}
                                        rx={1}
                                        className={FP_FILL[fingerprintColour(rowIndex, columnIndex) - 1]}
                                    />
                                ) : null,
                            ),
                        )}
                    </g>
                )}
            </svg>
            {fingerprint !== null && showCode ? (
                <span className={cx('font-mono tracking-wide text-(--trust-mark-code) tabular-nums', sizes.code)}>
                    {fingerprint.formatted}
                </span>
            ) : null}
        </span>
    );
}
