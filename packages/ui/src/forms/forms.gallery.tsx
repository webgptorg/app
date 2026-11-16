import { useEffect, useState } from 'react';
import { z } from 'zod';

import { Button } from '../components/button/button';
import { Checkbox } from '../components/checkbox/checkbox';
import { Combobox } from '../components/combobox/combobox';
import { DateInput } from '../components/date-input/date-input';
import { Field } from '../components/field/field';
import { Input } from '../components/input/input';
import { Select } from '../components/select/select';
import { Switch } from '../components/switch/switch';
import { Textarea } from '../components/textarea/textarea';
import type { GalleryEntry } from '../gallery-entry';
import { Form, FormSubmit } from './form';
import { FormField } from './form-field';
import { SensitiveInput, useSensitiveInput } from './sensitive-input';
import { applyServerErrors } from './server-errors';
import { useZodForm } from './use-zod-form';

const AgentSchema = z.object({
    name: z.string().min(1, 'Give the agent a name'),
    description: z.string().max(200, 'Keep it under 200 characters'),
    model: z.enum(['fast', 'balanced', 'thorough']),
    public: z.boolean(),
    notify: z.boolean(),
});

function GalleryForm() {
    const secret = useSensitiveInput();
    const form = useZodForm({
        schema: AgentSchema,
        defaultValues: { name: 'Lead bot', description: '', model: 'balanced', public: false, notify: true },
        onSubmit: async () => {
            secret.read();
            secret.clear();
            await new Promise((resolve) => setTimeout(resolve, 800));
        },
    });
    useEffect(() => {
        applyServerErrors(form, [{ path: '/name', message: 'An agent with this name already exists' }]);
    }, [form]);
    return (
        <Form form={form} aria-label="Gallery form" className="flex max-w-md flex-col gap-4">
            <FormField form={form} name="name" label="Name" hint="Shown in the sidebar and in chats" required>
                {(control) => <Input {...control.text} />}
            </FormField>
            <FormField form={form} name="description" label="Description">
                {(control) => <Textarea rows={3} {...control.text} />}
            </FormField>
            <FormField form={form} name="model" label="Model">
                {(control) => (
                    <Select {...control.text}>
                        <option value="fast">{'Fast'}</option>
                        <option value="balanced">{'Balanced'}</option>
                        <option value="thorough">{'Thorough'}</option>
                    </Select>
                )}
            </FormField>
            <FormField form={form} name="public" label="Visible to every member">
                {(control) => <Checkbox {...control.checkbox} />}
            </FormField>
            <form.Field name="notify">
                {(field) => (
                    <Switch
                        label="Email me when a run fails"
                        name={field.name}
                        checked={field.state.value}
                        onChange={(event) => {
                            field.handleChange(event.target.checked);
                        }}
                        onBlur={field.handleBlur}
                    />
                )}
            </form.Field>
            <Field label="API key" hint="Stored on your engine; never shown again">
                {(control) => <SensitiveInput {...control} handle={secret} />}
            </Field>
            <div>
                <FormSubmit form={form}>{'Save agent'}</FormSubmit>
            </div>
        </Form>
    );
}

const MODELS = [
    { value: 'fast', label: 'Fast' },
    { value: 'balanced', label: 'Balanced' },
];

/** Every control that can share a line, side by side: their edges must line up (36px, `CONTROL_HEIGHT`). */
function ControlRow() {
    const [model, setModel] = useState<string | null>('balanced');
    return (
        <div role="group" aria-label="Controls in one row" className="flex flex-wrap items-start gap-2">
            <Input aria-label="Agent name" defaultValue="Lead bot" className="w-40" />
            <Select aria-label="Visibility" defaultValue="team" className="w-32">
                <option value="team">{'Team'}</option>
                <option value="private">{'Only me'}</option>
            </Select>
            <Combobox aria-label="Model" options={MODELS} value={model} onChange={setModel} className="w-36" />
            <DateInput aria-label="Starts" defaultValue="2026-11-16" className="w-44" />
            <Textarea aria-label="Note" rows={1} className="w-40" />
            <Button variant="primary">{'Save'}</Button>
            <Button>{'Cancel'}</Button>
        </div>
    );
}

export const formsGallery: GalleryEntry = {
    id: 'form',
    title: 'Form',
    render: () => (
        <div className="flex flex-col gap-8">
            <ControlRow />
            <GalleryForm />
        </div>
    ),
};
