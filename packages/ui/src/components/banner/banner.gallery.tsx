import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { Banner } from './banner';
import type { BannerTone } from './banner';

const TONES: readonly BannerTone[] = ['info', 'success', 'warning', 'danger'];

export const bannerGallery: GalleryEntry = {
    id: 'banner',
    title: 'Banner',
    render: () => (
        <div className="flex flex-col gap-3">
            {TONES.map((tone) => (
                <Banner key={tone} tone={tone} title={`${tone} title`}>
                    {`A ${tone} message.`}
                </Banner>
            ))}
            <Banner tone="info" action={<Button size="sm">{'Action'}</Button>} onDismiss={() => undefined}>
                {'With an action and a dismiss button.'}
            </Banner>
        </div>
    ),
};
