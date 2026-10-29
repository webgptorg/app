import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { LanguageSwitch } from './language-switch';

const LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'cs', name: 'Čeština' },
] as const;

function Demo() {
    const [current, setCurrent] = useState<'en' | 'cs'>('en');
    return <LanguageSwitch languages={LANGUAGES} current={current} onChange={setCurrent} align="start" />;
}

export const languageSwitchGallery: GalleryEntry = {
    id: 'language-switch',
    title: 'LanguageSwitch',
    render: () => <Demo />,
};
