import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { TrustMark } from './trust-mark';
import type { TrustMarkSize, TrustMarkState } from './trust-mark';

const SAMPLE_ENGINE_ID = 'k3v6xq2mfz4pd7h5wn2rbtcayu';
const OTHER_ENGINE_ID = 'q4ndy7ejw3zkp6ftr2hcm5sxlg';
const SIZES: readonly TrustMarkSize[] = ['sm', 'md', 'lg'];

function ReplaySeal() {
    const [state, setState] = useState<TrustMarkState>('verified');
    return (
        <div className="flex flex-wrap items-center gap-4">
            <TrustMark engineId={SAMPLE_ENGINE_ID} state={state} size="lg" />
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
                    <TrustMark engineId={SAMPLE_ENGINE_ID} state="verified" size={size} />
                    <TrustMark engineId={OTHER_ENGINE_ID} state="verifying" size={size} />
                    <TrustMark engineId={null} state="verified" size={size} />
                </div>
            ))}
            <TrustMark engineId={SAMPLE_ENGINE_ID} state="verified" showCode={false} />
            <ReplaySeal />
        </div>
    ),
};
