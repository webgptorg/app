import type { GalleryEntry } from '../../gallery-entry';
import { EngineSwitcher } from './engine-switcher';

const CURRENT = { name: 'Acme engine', engineId: 'local-dev-engine-7', hostname: 'acme.engine.example' };
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
                        engineId: 'lab',
                        hostname: 'lab.engine.example',
                        status: 'online',
                        href: 'https://lab.engine.example/',
                    },
                    {
                        name: 'Archive',
                        engineId: 'archive',
                        hostname: 'archive.engine.example',
                        status: 'offline',
                        href: 'https://archive.engine.example/',
                    },
                    {
                        name: 'Fresh install',
                        engineId: null,
                        hostname: 'new.engine.example',
                        status: 'unknown',
                        href: 'https://new.engine.example/',
                    },
                ]}
                allEnginesHref={DASHBOARD}
                addEngineHref={`${DASHBOARD}/engines/new`}
            />
            <EngineSwitcher current={CURRENT} engines={[]} allEnginesHref={null} addEngineHref={null} />
            <EngineSwitcher current={CURRENT} engines={[]} allEnginesHref={DASHBOARD} addEngineHref={null} compact />
        </div>
    ),
};
