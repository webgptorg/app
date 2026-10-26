import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { SAMPLE_FINGERPRINTS } from './sample-fingerprints';
import { TrustMark } from './trust-mark';
import type { TrustMarkSize, TrustMarkState } from './trust-mark';

const SIZES: readonly TrustMarkSize[] = ['sm', 'md', 'lg'];

function ReplaySeal() {
    const [state, setState] = useState<TrustMarkState>('verified');
    return (
        <div className="flex flex-wrap items-center gap-4">
            <TrustMark fingerprint={SAMPLE_FINGERPRINTS.lead} state={state} size="lg" />
            <Button
                onClick={() => {
                    setState('verifying');
                    window.setTimeout(() => {
                        setState('verified');
                    }, 400);
                }}
            >
                {'Replay verification'}
            </Button>
        </div>
    );
}

export const trustMarkGallery: GalleryEntry = {
    id: 'trust-mark',
    title: 'TrustMark',
    render: () => (
        <div className="flex flex-col gap-4">
            {SIZES.map((size) => (
                <div key={size} className="flex flex-wrap items-center gap-6">
                    <TrustMark fingerprint={SAMPLE_FINGERPRINTS.lead} state="verified" size={size} />
                    <TrustMark fingerprint={SAMPLE_FINGERPRINTS.lab} state="verifying" size={size} />
                    <TrustMark fingerprint={null} state="verified" size={size} />
                </div>
            ))}
            <TrustMark fingerprint={SAMPLE_FINGERPRINTS.lead} state="verified" showCode={false} />
            <ReplaySeal />
        </div>
    ),
};
