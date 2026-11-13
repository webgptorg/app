import { Bot, FileText, ListTodo, Play, Zap } from 'lucide-react';

import type { GalleryEntry } from '../../gallery-entry';
import { Avatar } from '../avatar/avatar';
import { EntityChip } from './entity-chip';

const card = (text: string) => <span className="text-sm">{text}</span>;

export const entityChipGallery: GalleryEntry = {
    id: 'entity-chip',
    title: 'EntityChip',
    render: () => (
        <div className="flex max-w-2xl flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <EntityChip
                    tone="agent"
                    label="Copywriter"
                    tint="var(--color-agent-2)"
                    leading={<Avatar name="Copywriter" tint="var(--color-agent-2)" size="2xs" />}
                    hovercard={{ label: 'Copywriter', content: card('Writes launch copy.') }}
                />
                <EntityChip
                    tone="agent"
                    label="Ada"
                    tint="var(--color-agent-1)"
                    leading={<Avatar name="Ada" tint="var(--color-agent-1)" size="2xs" />}
                />
                <EntityChip
                    label="Ship billing"
                    leading={<ListTodo />}
                    tint="var(--color-live)"
                    status="live"
                    statusLabel="Running"
                    hovercard={{ label: 'Ship billing', content: card('Running for 4:12') }}
                />
                <EntityChip
                    label="Weekly report"
                    leading={<ListTodo />}
                    tint="var(--color-danger)"
                    status="danger"
                    statusLabel="Failed"
                />
                <EntityChip label="Morning run" leading={<Play />} status="success" statusLabel="Completed" />
                <EntityChip label="pricing-2026.pdf" leading={<FileText />} />
                <EntityChip label="Every Monday 8:00" leading={<Zap />} />
                <EntityChip label="Chatter" leading={<Bot />} interactive={false} />
            </div>
            <p className="max-w-md text-sm">
                {'In running text a chip wraps with it: '}
                <EntityChip
                    wrap
                    tone="agent"
                    label="@Copywriter"
                    tint="var(--color-agent-2)"
                    hovercard={{ label: 'Copywriter', content: card('Writes launch copy.') }}
                />
                {' is drafting '}
                <EntityChip wrap label="Launch email for the spring pricing update" leading={<ListTodo />} />
                {' now.'}
            </p>
            <div className="w-48 text-sm">
                <EntityChip label="A very long task name that truncates in a narrow cell" leading={<ListTodo />} />
            </div>
        </div>
    ),
};
