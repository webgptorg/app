import { Bot, Settings } from 'lucide-react';
import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { CommandPalette } from './command-palette';
import type { CommandPaletteGroup } from './command-palette';

const GROUPS: readonly CommandPaletteGroup[] = [
    {
        id: 'navigation',
        label: 'Go to',
        items: [
            { id: 'agents', label: 'Agents', icon: <Bot className="size-4" /> },
            { id: 'settings', label: 'Settings', icon: <Settings className="size-4" /> },
        ],
    },
    {
        id: 'agents',
        label: 'Agents',
        items: [
            { id: 'agent-ada', label: 'Ada', detail: 'Research' },
            { id: 'agent-hostile', label: '<img src=x onerror=alert(1)>', detail: 'Names stay text' },
        ],
    },
];

function PaletteDemo({ label, loading = false }: { label: string; loading?: boolean }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const groups = GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
    }));
    return (
        <>
            <Button
                onClick={() => {
                    setOpen(true);
                }}
            >
                {label}
            </Button>
            <CommandPalette
                open={open}
                onClose={() => {
                    setOpen(false);
                }}
                title="Command palette"
                label="Search agents, pages and commands"
                placeholder="Search or jump to…"
                query={query}
                onQueryChange={setQuery}
                groups={groups}
                onSelect={() => {
                    setOpen(false);
                }}
                loading={loading}
                emptyText="Nothing matches"
                resultsText={(count) => `${String(count)} results`}
                keyHints={[
                    { keys: '↑↓', label: 'Move' },
                    { keys: '↵', label: 'Open' },
                    { keys: 'Esc', label: 'Close' },
                ]}
            />
        </>
    );
}

export const commandPaletteGallery: GalleryEntry = {
    id: 'command-palette',
    title: 'CommandPalette',
    render: () => (
        <div className="flex flex-wrap gap-3">
            <PaletteDemo label="Open the palette" />
            <PaletteDemo label="Open while searching" loading />
        </div>
    ),
};
