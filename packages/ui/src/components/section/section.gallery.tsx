import { Inbox, ListTodo } from 'lucide-react';

import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { EmptyState } from '../empty-state/empty-state';
import { StatusPill } from '../status/status';
import { Section } from './section';

export const sectionGallery: GalleryEntry = {
    id: 'section',
    title: 'Section',
    render: () => (
        <div className="flex max-w-2xl flex-col gap-6">
            <Section
                title="Working now"
                count={2}
                divided={false}
                actions={
                    <Button size="sm" variant="ghost">
                        {'View all'}
                    </Button>
                }
            >
                <ul className="flex flex-col">
                    {['Ship billing', 'Weekly report'].map((name) => (
                        <li
                            key={name}
                            className="flex min-h-10 items-center gap-2 border-b border-hairline text-sm last:border-b-0"
                        >
                            <ListTodo aria-hidden="true" className="size-4 text-text-muted" />
                            <span className="flex-1 truncate">{name}</span>
                            <StatusPill tone="live">{'Running'}</StatusPill>
                        </li>
                    ))}
                </ul>
            </Section>
            <Section title="Needs you" description="Questions from agents, failed work and sign-in requests.">
                <div className="soft-surface p-3 text-sm [--tint:var(--color-warning)]">
                    {'Copywriter asks: which tone for the launch email?'}
                </div>
            </Section>
            <Section title="Recent chats">
                <EmptyState
                    variant="inline"
                    icon={<Inbox />}
                    title="No chats yet."
                    action={<Button size="sm">{'Start a chat'}</Button>}
                />
            </Section>
        </div>
    ),
};
