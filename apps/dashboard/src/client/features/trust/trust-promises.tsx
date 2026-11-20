import { ExternalLink } from '@ptbk/ui';
import type { ComponentType } from 'react';

import { m } from '../../../paraglide/messages';
import {
    CardIcon,
    ClosedEyeIcon,
    EnvelopeIcon,
    KeyIcon,
    MagnifierIcon,
    PowerIcon,
    PulseIcon,
    SealIcon,
} from './trust-art';

/** The open-source engine, the half of the system anyone can read (spec, Transparency and verifiability). */
const ENGINE_SOURCE = 'https://github.com/webgptorg/promptbook';

interface Point {
    readonly id: string;
    readonly title: () => string;
    readonly body: () => string;
    readonly Icon: ComponentType<{ readonly className?: string }>;
}

const CANNOT: readonly Point[] = [
    { id: 'see', title: () => m.trust_cannot_see_title(), body: () => m.trust_cannot_see_body(), Icon: ClosedEyeIcon },
    {
        id: 'open',
        title: () => m.trust_cannot_open_title(),
        body: () => m.trust_cannot_open_body(),
        Icon: EnvelopeIcon,
    },
    {
        id: 'change',
        title: () => m.trust_cannot_change_title(),
        body: () => m.trust_cannot_change_body(),
        Icon: SealIcon,
    },
    { id: 'admit', title: () => m.trust_cannot_admit_title(), body: () => m.trust_cannot_admit_body(), Icon: KeyIcon },
    { id: 'card', title: () => m.trust_cannot_card_title(), body: () => m.trust_cannot_card_body(), Icon: CardIcon },
];

/** Said as plainly as the rest: what we can do is the spec's short list, so nobody has to guess at the gaps. */
const CAN: readonly Point[] = [
    { id: 'status', title: () => m.trust_can_status_title(), body: () => m.trust_can_status_body(), Icon: PulseIcon },
    { id: 'stop', title: () => m.trust_can_stop_title(), body: () => m.trust_can_stop_body(), Icon: PowerIcon },
];

function Points(props: {
    readonly id: string;
    readonly title: string;
    readonly points: readonly Point[];
    readonly iconClassName: string;
}) {
    const titleId = `trust-${props.id}-title`;
    return (
        <section aria-labelledby={titleId} className="flex flex-col gap-5">
            <h2 id={titleId} className="text-xl font-semibold">
                {props.title}
            </h2>
            <ul className="grid gap-x-10 gap-y-6 md:grid-cols-2">
                {props.points.map((point) => (
                    <li key={point.id} data-trust-point={point.id} className="flex gap-4">
                        <point.Icon className={`mt-0.5 size-7 shrink-0 ${props.iconClassName}`} />
                        <div className="flex flex-col gap-1">
                            <h3 className="font-semibold">{point.title()}</h3>
                            <p className="text-sm text-text-muted">{point.body()}</p>
                        </div>
                    </li>
                ))}
            </ul>
        </section>
    );
}

export function TrustCannot() {
    return <Points id="cannot" title={m.trust_cannot_title()} points={CANNOT} iconClassName="text-accent-text" />;
}

export function TrustCan() {
    return <Points id="can" title={m.trust_can_title()} points={CAN} iconClassName="text-text-muted" />;
}

export function TrustCheck() {
    return (
        <section
            aria-labelledby="trust-check-title"
            className="flex flex-col gap-3 rounded-surface bg-sunken p-5 sm:flex-row sm:gap-4"
        >
            <MagnifierIcon className="size-7 shrink-0 text-accent-text" />
            <div className="flex flex-col gap-2">
                <h2 id="trust-check-title" className="text-xl font-semibold">
                    {m.trust_check_title()}
                </h2>
                <p className="text-sm">{m.trust_check_security()}</p>
                <p className="text-sm">{m.trust_check_fingerprint()}</p>
                <p className="text-sm">
                    {m.trust_check_source()}{' '}
                    <ExternalLink href={ENGINE_SOURCE}>{m.trust_check_source_link()}</ExternalLink>
                </p>
            </div>
        </section>
    );
}
