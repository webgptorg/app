import type { ReactNode } from 'react';

/*
 * The trust page's drawings. They are decoration for text that already says everything, so each one is hidden from
 * assistive technology, and colours come from theme tokens or currentColor so light and dark both hold.
 */

interface ArtProps {
    readonly className?: string;
}

function Art(props: {
    readonly viewBox: string;
    readonly className: string | undefined;
    readonly children: ReactNode;
}) {
    return (
        <svg
            viewBox={props.viewBox}
            aria-hidden="true"
            focusable="false"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            {props.children}
        </svg>
    );
}

const round = (value: number) => Math.round(value * 100) / 100;

/** The scalloped outline of the Promptbook seal (the trust mark), so "signed" looks like the mark people see later. */
function rosettePath(centre: number, inner: number, outer: number, lobes: number): string {
    const step = (2 * Math.PI) / lobes;
    const at = (radius: number, angle: number) =>
        `${String(round(centre + radius * Math.cos(angle)))} ${String(round(centre + radius * Math.sin(angle)))}`;
    let path = `M ${at(inner, -Math.PI / 2)}`;
    for (let lobe = 0; lobe < lobes; lobe += 1) {
        const start = -Math.PI / 2 + lobe * step;
        path += ` Q ${at(outer, start + step / 2)} ${at(inner, start + step)}`;
    }
    return `${path} Z`;
}

const ICON_SEAL = rosettePath(12, 8.4, 10.2, 12);

/** A closed envelope with the seal dot: what travels between the browser and the engine. */
function Envelope(props: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }) {
    const { x, y, width, height } = props;
    const middle = x + width / 2;
    const fold = y + height * 0.55;
    return (
        <g>
            <rect x={x} y={y} width={width} height={height} rx={2} className="fill-raised" />
            <path
                d={`M ${String(x)} ${String(y + 1)} L ${String(middle)} ${String(fold)} L ${String(x + width)} ${String(y + 1)}`}
            />
            <circle cx={middle} cy={fold} r={height * 0.19} className="fill-accent stroke-accent" />
        </g>
    );
}

export function BrowserArt({ className }: ArtProps) {
    return (
        <Art viewBox="0 0 80 64" className={className}>
            <rect x={4} y={6} width={72} height={52} rx={7} className="fill-raised" />
            <path d="M4 18 H76" />
            <circle cx={12} cy={12} r={1.4} className="fill-current" />
            <circle cx={18} cy={12} r={1.4} className="fill-current" />
            <circle cx={24} cy={12} r={1.4} className="fill-current" />
            <rect x={13} y={26} width={36} height={10} rx={5} className="fill-accent-soft stroke-accent" />
            <rect x={31} y={41} width={36} height={10} rx={5} className="fill-sunken" />
        </Art>
    );
}

/** The sealed envelope passing through a hoop: the relay is something traffic goes through, not into. */
export function RelayArt({ className }: ArtProps) {
    return (
        <Art viewBox="0 0 80 64" className={className}>
            <path d="M2 32 H78" strokeDasharray="1 5" className="stroke-text-muted" />
            <path d="M40 6 A13 26 0 0 0 40 58" />
            <Envelope x={27} y={23} width={26} height={18} />
            <path d="M40 6 A13 26 0 0 1 40 58" />
        </Art>
    );
}

export function EngineArt({ className }: ArtProps) {
    return (
        <Art viewBox="0 0 80 64" className={className}>
            <rect x={12} y={6} width={56} height={22} rx={5} className="fill-accent-soft" />
            <rect x={12} y={36} width={56} height={22} rx={5} className="fill-accent-soft" />
            <circle cx={22} cy={17} r={2.2} className="fill-accent stroke-accent" />
            <path d="M31 17 H58" />
            <circle cx={22} cy={47} r={2.2} className="fill-accent stroke-accent" />
            <path d="M31 47 H42" />
            <circle cx={50} cy={47} r={3.6} className="stroke-accent" />
            <path d="M53.6 47 H62 M59.5 47 V50.5" className="stroke-accent" />
        </Art>
    );
}

export function DashboardArt({ className }: ArtProps) {
    return (
        <Art viewBox="0 0 80 64" className={className}>
            <rect x={6} y={8} width={68} height={48} rx={7} className="fill-raised" />
            <rect x={20} y={32} width={9} height={14} rx={1.5} className="fill-sunken" />
            <rect x={35.5} y={22} width={9} height={24} rx={1.5} className="fill-sunken" />
            <rect x={51} y={27} width={9} height={19} rx={1.5} className="fill-sunken" />
            <path d="M15 46 H65" />
        </Art>
    );
}

/** The connection between two diagram stops: a sealed envelope on the line, sideways on wide screens. */
export function SealedPath(props: { readonly direction: 'across' | 'down'; readonly className?: string }) {
    return props.direction === 'across' ? (
        <Art viewBox="0 0 72 24" className={props.className}>
            <path d="M2 12 H67 M62 7 L67 12 L62 17" className="stroke-text-muted" />
            <Envelope x={25} y={4} width={22} height={15} />
        </Art>
    ) : (
        <Art viewBox="0 0 24 64" className={props.className}>
            <path d="M12 2 V59 M7 54 L12 59 L17 54" className="stroke-text-muted" />
            <Envelope x={1} y={21} width={22} height={15} />
        </Art>
    );
}

export function ClosedEyeIcon({ className }: ArtProps) {
    return (
        <Art viewBox="0 0 24 24" className={className}>
            <path d="M3 10 C7 15.5 17 15.5 21 10" />
            <path d="M6.2 13.6 L4.6 16.2 M10 15.1 L9.4 18.2 M14 15.1 L14.6 18.2 M17.8 13.6 L19.4 16.2" />
        </Art>
    );
}

export function EnvelopeIcon({ className }: ArtProps) {
    return (
        <Art viewBox="0 0 24 24" className={className}>
            <rect x={3} y={5.5} width={18} height={13} rx={2} />
            <path d="M3.5 6.5 L12 13 L20.5 6.5" />
            <circle cx={12} cy={13} r={2.1} className="fill-current" />
        </Art>
    );
}

export function SealIcon({ className }: ArtProps) {
    return (
        <Art viewBox="0 0 24 24" className={className}>
            <path d={ICON_SEAL} />
            <path d="M8.6 12.3 L11 14.7 L15.4 9.6" />
        </Art>
    );
}

export function KeyIcon({ className }: ArtProps) {
    return (
        <Art viewBox="0 0 24 24" className={className}>
            <circle cx={8} cy={12} r={4.2} />
            <path d="M12.2 12 H21 M18 12 V15.2 M21 12 V14.4" />
        </Art>
    );
}

export function PulseIcon({ className }: ArtProps) {
    return (
        <Art viewBox="0 0 24 24" className={className}>
            <path d="M3 12 H7 L9.5 6.5 L13.5 17.5 L16 12 H21" />
        </Art>
    );
}

export function PowerIcon({ className }: ArtProps) {
    return (
        <Art viewBox="0 0 24 24" className={className}>
            <path d="M12 3.5 V11" />
            <path d="M7.2 6.6 A7.5 7.5 0 1 0 16.8 6.6" />
        </Art>
    );
}

export function MagnifierIcon({ className }: ArtProps) {
    return (
        <Art viewBox="0 0 24 24" className={className}>
            <circle cx={10.5} cy={10.5} r={6.5} />
            <path d="M15.3 15.3 L20.5 20.5" />
            <path d="M7.7 10.7 L9.8 12.8 L13.3 8.8" />
        </Art>
    );
}
