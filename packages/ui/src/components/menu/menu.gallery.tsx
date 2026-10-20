import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { Menu } from './menu';

function MenuDemo() {
    const [last, setLast] = useState('none');
    const [language, setLanguage] = useState('en');
    return (
        <div className="flex flex-wrap items-center gap-3">
            <Menu
                label="Agent actions"
                items={[
                    { kind: 'heading', id: 'agent', label: 'Agent' },
                    {
                        kind: 'item',
                        id: 'rename',
                        label: 'Rename',
                        description: 'Members see it at once',
                        icon: <Pencil className="size-4" />,
                        onSelect: () => {
                            setLast('rename');
                        },
                    },
                    {
                        kind: 'item',
                        id: 'archive',
                        label: 'Archive',
                        disabled: true,
                        onSelect: () => {
                            setLast('archive');
                        },
                    },
                    { kind: 'link', id: 'docs', label: 'Read the guide', href: '#menu' },
                    { kind: 'separator', id: 'danger' },
                    {
                        kind: 'item',
                        id: 'delete',
                        label: 'Delete',
                        tone: 'danger',
                        icon: <Trash2 className="size-4" />,
                        onSelect: () => {
                            setLast('delete');
                        },
                    },
                ]}
                trigger={(props) => <Button {...props}>Actions</Button>}
            />
            <Menu
                label="Language"
                align="end"
                items={[
                    {
                        kind: 'item',
                        id: 'en',
                        label: 'English',
                        checked: language === 'en',
                        onSelect: () => {
                            setLanguage('en');
                        },
                    },
                    {
                        kind: 'item',
                        id: 'cs',
                        label: 'Čeština',
                        checked: language === 'cs',
                        onSelect: () => {
                            setLanguage('cs');
                        },
                    },
                ]}
                trigger={(props) => (
                    <Button variant="ghost" {...props}>
                        Language
                    </Button>
                )}
            />
            <output className="text-sm text-text-muted">{`Last action: ${last}, language: ${language}`}</output>
        </div>
    );
}

export const menuGallery: GalleryEntry = { id: 'menu', title: 'Menu', render: () => <MenuDemo /> };
