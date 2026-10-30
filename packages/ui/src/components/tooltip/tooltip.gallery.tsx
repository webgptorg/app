import { Trash2 } from 'lucide-react';

import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { IconButton } from '../icon-button/icon-button';
import { Tooltip } from './tooltip';

export const tooltipGallery: GalleryEntry = {
    id: 'tooltip',
    title: 'Tooltip',
    render: () => (
        <div className="flex flex-wrap items-center gap-3">
            <Tooltip content="Agents">
                {(props) => <IconButton {...props} label="Open agents" icon={<span aria-hidden="true">{'A'}</span>} />}
            </Tooltip>
            <Button disabled disabledReason="Your only passkey cannot be removed. Add another one first.">
                {'Remove'}
            </Button>
            <IconButton
                label="Delete"
                icon={<Trash2 className="size-4" />}
                disabled
                disabledReason="You need the agents.delete permission"
            />
            {(['primary', 'secondary', 'ghost', 'danger'] as const).map((variant) => (
                <Button key={variant} variant={variant} disabled>
                    {`Disabled ${variant}`}
                </Button>
            ))}
        </div>
    ),
};
