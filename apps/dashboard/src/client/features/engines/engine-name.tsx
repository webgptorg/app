import { Button, Dialog, Form, FormField, FormSubmit, Input, useZodForm } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import { z } from 'zod';

import { m } from '../../../paraglide/messages';
import { apiRoutes, type EngineView } from '../../../shared/api/routes';
import { engineLabelSchema, normalizeEngineLabel, type EngineLabel } from '../../../shared/engine-label';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, queryKeys } from '../../api/queries';
import { useAppMutation } from '../../core/mutations';

const RENAME_PERMISSION = 'engine.rename';

export function canRename(permissions: readonly string[]): boolean {
    return permissions.includes(RENAME_PERMISSION);
}

/** An empty field clears the name; anything else must be a label the API takes as it is. */
function nameSchema() {
    return z.strictObject({
        name: z
            .string()
            .transform(normalizeEngineLabel)
            .refine((name) => name === '' || engineLabelSchema.safeParse(name).success, {
                error: m.engine_name_invalid(),
            }),
    });
}

function useRenameEngine(engineId: string, onSaved: () => void) {
    const api = useApiClient();
    const queryClient = useQueryClient();
    return useAppMutation({
        mutationFn: async (label: EngineLabel | null) =>
            dataOrThrow(await api.call(apiRoutes.renameEngine, { params: { engineId }, body: { label } })).engine,
        invalidates: [queryKeys.engines],
        successMessage: (_, label) => (label === null ? m.engine_name_cleared() : m.engine_name_saved()),
        onSuccess: (engine) => {
            queryClient.setQueryData(queryKeys.engine(engineId), engine);
            onSaved();
        },
    });
}

function NameForm(props: {
    readonly engine: Pick<EngineView, 'engineId' | 'label'>;
    readonly onSaved: () => void;
    readonly onCancel?: () => void;
}) {
    const rename = useRenameEngine(props.engine.engineId, props.onSaved);
    const schema = useMemo(() => nameSchema(), []);
    const form = useZodForm({
        schema,
        defaultValues: { name: props.engine.label ?? '' },
        onSubmit: async ({ name }) => {
            const label = name === '' ? null : engineLabelSchema.parse(name);
            if (label === props.engine.label) {
                props.onSaved();
                return;
            }
            await rename.mutateAsync(label).catch(() => undefined);
        },
    });
    return (
        <Form form={form} className="flex flex-col gap-3">
            <FormField form={form} name="name" label={m.engine_name_label()} hint={m.engine_name_hint()}>
                {({ text }) => <Input {...text} autoComplete="off" placeholder={m.engine_name_placeholder()} />}
            </FormField>
            <div className="flex flex-wrap justify-end gap-2">
                {props.onCancel === undefined ? null : (
                    <Button variant="ghost" onClick={props.onCancel}>
                        {m.engine_name_cancel()}
                    </Button>
                )}
                <FormSubmit form={form}>{m.engine_name_save()}</FormSubmit>
            </div>
        </Form>
    );
}

/**
 * Naming a just-linked engine, on the link page. Optional: an engine without a name is shown by its short ID, and it
 * can be named later on its page.
 */
export function EngineNameField(props: { readonly engine: Pick<EngineView, 'engineId' | 'label'> }) {
    return (
        <div className="max-w-md">
            <NameForm engine={props.engine} onSaved={() => undefined} />
        </div>
    );
}

/** "Rename" next to an engine page's title. */
export function RenameEngineButton(props: { readonly engine: Pick<EngineView, 'engineId' | 'label'> }) {
    const [open, setOpen] = useState(false);
    const close = () => {
        setOpen(false);
    };
    return (
        <>
            <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                    setOpen(true);
                }}
            >
                <Pencil aria-hidden className="size-4" />
                {props.engine.label === null ? m.engine_name_add() : m.engine_name_rename()}
            </Button>
            <Dialog
                open={open}
                onClose={close}
                title={props.engine.label === null ? m.engine_name_add_title() : m.engine_name_rename_title()}
                size="sm"
            >
                <NameForm engine={props.engine} onSaved={close} onCancel={close} />
            </Dialog>
        </>
    );
}
