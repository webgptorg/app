import { Card, Form, FormField, FormSubmit, Input, useZodForm } from '@ptbk/ui';
import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { z } from 'zod';

import { m } from '../../../../paraglide/messages';

const ENGINE_ID_PATTERN = /^[a-z2-7]{26}$/;

/**
 * Engines are found by their ID, which an abuse report (the hostname's first label) or a customer's request for a custom
 * domain carries; the engine's page has suspension and links to its custom domains.
 */
export function EngineLookupCard() {
    const navigate = useNavigate();
    const schema = useMemo(
        () =>
            z.strictObject({
                engineId: z
                    .string()
                    .trim()
                    .toLowerCase()
                    .regex(ENGINE_ID_PATTERN, { error: m.admin_hostnames_lookup_invalid() }),
            }),
        [],
    );
    const form = useZodForm({
        schema,
        defaultValues: { engineId: '' },
        onSubmit: ({ engineId }) => navigate({ to: '/admin/engines/$engineId', params: { engineId } }),
    });
    return (
        <Card title={m.admin_engines_title()}>
            <p className="mb-4 text-sm text-text-muted">{m.admin_engines_summary()}</p>
            <Form form={form} className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <FormField
                    form={form}
                    name="engineId"
                    label={m.admin_hostnames_lookup_label()}
                    hint={m.admin_hostnames_lookup_hint()}
                    required
                    className="sm:flex-1"
                >
                    {({ text }) => <Input {...text} autoComplete="off" spellCheck={false} className="font-mono" />}
                </FormField>
                <div>
                    <FormSubmit form={form}>{m.admin_hostnames_lookup_submit()}</FormSubmit>
                </div>
            </Form>
        </Card>
    );
}
