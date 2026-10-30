import { Copy, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { ActionMenu } from './action-menu';

function ActionMenuDemo() {
    const [last, setLast] = useState('none');
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary">
                    <Pencil aria-hidden="true" className="size-4" />
                    Edit
                </Button>
                <ActionMenu
                    items={[
                        {
                            kind: 'item',
                            id: 'duplicate',
                            label: 'Duplicate',
                            icon: <Copy className="size-4" />,
                            onSelect: () => {
                                setLast('duplicate');
                            },
                        },
                        { kind: 'separator', id: 'danger' },
                        {
                            kind: 'item',
                            id: 'delete',
                            label: 'Delete trigger',
                            tone: 'danger',
                            icon: <Trash2 className="size-4" />,
                            onSelect: () => {
                                setLast('delete');
                            },
                        },
                    ]}
                />
                <ActionMenu
                    variant="ghost"
                    size="sm"
                    label="Actions for Weekly report"
                    items={[
                        {
                            kind: 'item',
                            id: 'revoke',
                            label: 'Revoke',
                            tone: 'danger',
                            onSelect: () => {
                                setLast('revoke');
                            },
                        },
                    ]}
                />
            </div>
            <p className="text-sm text-text-muted">{`Last chosen: ${last}`}</p>
        </div>
    );
}

export const actionMenuGallery: GalleryEntry = {
    id: 'action-menu',
    title: 'ActionMenu',
    render: () => <ActionMenuDemo />,
};
