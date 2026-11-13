import { Bot, Globe, Lock, Users } from 'lucide-react';
import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Field } from '../field/field';
import { Monogram } from '../monogram/monogram';
import { Combobox } from './combobox';
import type { ComboboxOption, ComboboxProps } from './combobox';

const AGENTS: readonly ComboboxOption[] = [
    { value: 'ada', label: 'Ada', leading: <span className="size-2.5 rounded-pill bg-(--color-agent-1)" /> },
    { value: 'chatter', label: 'Chatter', leading: <span className="size-2.5 rounded-pill bg-(--color-agent-2)" /> },
    { value: 'scribe', label: 'Scribe', leading: <span className="size-2.5 rounded-pill bg-(--color-agent-3)" /> },
    { value: 'auditor', label: 'Auditor', leading: <Bot className="size-4" />, disabled: true },
];

const VISIBILITY: readonly ComboboxOption[] = [
    {
        value: 'private',
        label: 'Only me',
        description: 'Nobody else sees this agent.',
        leading: <Lock className="size-4" />,
    },
    {
        value: 'team',
        label: 'Team',
        description: 'Every member of this engine.',
        leading: <Users className="size-4" />,
    },
    {
        value: 'public',
        label: 'Anyone with the link',
        description: 'Read-only, no sign-in.',
        leading: <Globe className="size-4" />,
    },
];

const MEMBERS: readonly ComboboxOption[] = [
    'Šárka Dvořáková',
    'Jiří Novák',
    'Lucie Černá',
    'Tomáš Procházka',
    'Žofie Králová',
    'Ondřej Šimek',
    'Petra Růžičková',
    'Adam Kovář',
    'Eliška Horáková',
    'Marek Veselý',
    'Anna Pokorná',
    'Václav Říha',
].map((name) => ({
    value: name,
    label: name,
    leading: <Monogram name={name} className="size-4 text-[0.625rem]" />,
}));

function Demo({ initial = null, ...props }: Omit<ComboboxProps, 'value' | 'onChange'> & { initial?: string | null }) {
    const [value, setValue] = useState<string | null>(initial);
    return <Combobox {...props} value={value} onChange={setValue} />;
}

export const comboboxGallery: GalleryEntry = {
    id: 'combobox',
    title: 'Combobox',
    render: () => (
        <div className="grid max-w-md gap-3">
            <Demo aria-label="Agent" options={AGENTS} initial="ada" />
            <Demo aria-label="Agent with placeholder" options={AGENTS} placeholder="Choose an agent…" />
            <Demo aria-label="Visibility" options={VISIBILITY} initial="team" />
            <Demo
                aria-label="Member"
                options={MEMBERS}
                searchable
                searchPlaceholder="Search members…"
                placeholder="Assign a member…"
            />
            <Demo aria-label="Invalid agent" options={AGENTS} placeholder="Choose an agent…" invalid />
            <Demo aria-label="Disabled agent" options={AGENTS} initial="chatter" disabled />
            <Demo aria-label="Small agent" options={AGENTS} initial="scribe" size="sm" className="max-w-48" />
            <Field label="Owner" hint="Gets the notifications for this task." error="Choose an owner." required>
                {(control) => (
                    <Demo {...control} options={MEMBERS} searchable placeholder="Assign a member…" name="owner" />
                )}
            </Field>
        </div>
    ),
};
