import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Tabs } from './tabs';

function TabsDemo() {
    const [selectedId, setSelectedId] = useState('overview');
    return (
        <Tabs
            label="Agent"
            selectedId={selectedId}
            onSelect={setSelectedId}
            tabs={[
                {
                    id: 'overview',
                    label: 'Overview',
                    panel: <p className="text-sm">Identity, status and recent runs.</p>,
                },
                { id: 'chat', label: 'Chat', panel: <p className="text-sm">Conversation with the agent.</p> },
                { id: 'book', label: 'Book', panel: <p className="text-sm">The agent source.</p>, disabled: true },
                { id: 'runs', label: 'Runs', panel: <p className="text-sm">Every unit of work.</p> },
            ]}
        />
    );
}

export const tabsGallery: GalleryEntry = { id: 'tabs', title: 'Tabs', render: () => <TabsDemo /> };
