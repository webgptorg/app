import type { GalleryEntry } from '../../gallery-entry';
import { SAMPLE_FINGERPRINTS } from '../trust-mark/sample-fingerprints';
import { EngineSwitcher } from './engine-switcher';

const CURRENT = { name: 'Acme engine', fingerprint: SAMPLE_FINGERPRINTS.local, hostname: 'acme.engine.example' };
const DASHBOARD = 'https://app.ptbk.example';

export const engineSwitcherGallery: GalleryEntry = {
    id: 'engine-switcher',
    title: 'EngineSwitcher',
    render: () => (
        <div className="grid max-w-xs gap-4">
            <EngineSwitcher
                current={CURRENT}
                engines={[]}
                allEnginesHref={DASHBOARD}
                addEngineHref={`${DASHBOARD}/engines/new`}
            />
            <EngineSwitcher
                current={CURRENT}
                engines={[
                    {
                        name: 'Research lab',
                        fingerprint: SAMPLE_FINGERPRINTS.lab,
                        hostname: 'lab.engine.example',
                        status: 'online',
                        href: 'https://lab.engine.example/',
                    },
                    {
                        name: 'Archive',
                        fingerprint: SAMPLE_FINGERPRINTS.lead,
                        hostname: 'archive.engine.example',
                        status: 'offline',
                        href: 'https://archive.engine.example/',
                    },
                    {
                        name: 'Fresh install',
                        fingerprint: null,
                        hostname: 'new.engine.example',
                        status: 'unknown',
                        href: 'https://new.engine.example/',
                    },
                ]}
                allEnginesHref={DASHBOARD}
                addEngineHref={`${DASHBOARD}/engines/new`}
            />
            <EngineSwitcher
                current={CURRENT}
                engines={[]}
                allEnginesHref={null}
                addEngineHref={null}
                leadingItems={[
                    {
                        kind: 'item',
                        id: 'verify',
                        label: 'Verify this engine',
                        description: CURRENT.fingerprint.formatted,
                        onSelect: () => undefined,
                    },
                ]}
            />
            <EngineSwitcher current={CURRENT} engines={[]} allEnginesHref={DASHBOARD} addEngineHref={null} compact />
        </div>
    ),
};
