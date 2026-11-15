import { AtSign, ListTodo, Play } from 'lucide-react';
import type { ReactNode } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Avatar } from '../avatar/avatar';
import { Button } from '../button/button';
import { EntityChip } from '../entity-chip/entity-chip';
import { Hovercard } from '../hovercard/hovercard';
import { STATUS_TINT_CLASSES } from '../status/status';
import { PeekCard } from './peek-card';

/** The hovercard's own frame, so the cards show without hovering. */
function Frame({ children }: { readonly children: ReactNode }) {
    return (
        <span className="inline-block rounded-(--hovercard-radius) border border-(--hovercard-border) bg-(--hovercard-bg) p-3 align-top shadow-(--hovercard-shadow)">
            {children}
        </span>
    );
}

const agent = (
    <PeekCard
        kind="Agent"
        icon={<Avatar name="Copywriter" tint="var(--color-agent-2)" size="xs" />}
        status={{ tone: 'live', label: 'Working' }}
        title="Copywriter"
        description="Writes marketing copy from what the project really has."
        tint="var(--color-agent-2)"
        facts={[
            {
                label: 'Working on',
                value: <EntityChip label="Launch email" leading={<ListTodo />} interactive={false} />,
            },
            { label: 'For', value: '4:12' },
        ]}
        action={{ label: 'Open agent', onSelect: () => undefined }}
        secondary={
            <Button size="sm" variant="ghost">
                <AtSign aria-hidden="true" className="size-3.5" />
                {'Mention'}
            </Button>
        }
    />
);

const task = (
    <PeekCard
        kind="Task"
        icon={<ListTodo />}
        status={{ tone: 'danger', label: 'Failed' }}
        title="Ship billing v2"
        description="Dependency {Export invoices} was not found."
        tintClassName={STATUS_TINT_CLASSES.danger}
        facts={[
            {
                label: 'Agent',
                value: (
                    <EntityChip
                        tone="agent"
                        label="Ada"
                        tint="var(--color-agent-1)"
                        leading={<Avatar name="Ada" tint="var(--color-agent-1)" size="2xs" />}
                        interactive={false}
                    />
                ),
            },
            { label: 'Took', value: '0:21' },
            { label: 'Commit', value: <span className="font-mono">{'67b252c'}</span> },
        ]}
        action={{ label: 'Open task', onSelect: () => undefined }}
    />
);

const run = (
    <PeekCard
        kind="Run"
        icon={<Play />}
        status={{ tone: 'success', label: 'Completed' }}
        title="Weekly report"
        tint="var(--color-agent-5)"
        facts={[
            { label: 'Started', value: 'Today 08:00' },
            { label: 'Cost', value: '$0.31' },
        ]}
        action={{ label: 'Open run', onSelect: () => undefined }}
    />
);

export const peekCardGallery: GalleryEntry = {
    id: 'peek-card',
    title: 'PeekCard',
    render: () => (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start gap-6">
                <Frame>{agent}</Frame>
                <Frame>{task}</Frame>
                <Frame>{run}</Frame>
            </div>
            <p className="text-sm">
                {'In a hovercard: '}
                <Hovercard label="Ship billing v2" content={task}>
                    {(props) => (
                        <button type="button" {...props} className="cursor-pointer font-medium underline">
                            {'Ship billing v2'}
                        </button>
                    )}
                </Hovercard>
            </p>
        </div>
    ),
};
