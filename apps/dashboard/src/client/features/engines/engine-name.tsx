import { Button, Dialog, Field, Input } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useRef, useState } from 'react';

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
function parseName(typed: string): { readonly label: EngineLabel | null } | null {
    const name = normalizeEngineLabel(typed);
    if (name === '') {
        return { label: null };
    }
    const parsed = engineLabelSchema.safeParse(name);
    return parsed.success ? { label: parsed.data } : null;
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

/**
 * One field, so plain state rather than the form layer, which would double these routes' bundles. Like the form layer,
 * it checks on submit and then on every change, so an error goes away as soon as it is fixed.
 */
function NameForm(props: {
    readonly engine: Pick<EngineView, 'engineId' | 'label'>;
    readonly onSaved: () => void;
    readonly onCancel?: () => void;
}) {
    const rename = useRenameEngine(props.engine.engineId, props.onSaved);
    const input = useRef<HTMLInputElement>(null);
    const [typed, setTyped] = useState(props.engine.label ?? '');
    const [submitted, setSubmitted] = useState(false);
    const invalid = submitted && parseName(typed) === null;
    const submit = async () => {
        setSubmitted(true);
        const parsed = parseName(typed);
        if (parsed === null) {
            input.current?.focus();
            return;
        }
        if (parsed.label === props.engine.label) {
            props.onSaved();
            return;
        }
        await rename.mutateAsync(parsed.label).catch(() => undefined);
    };
    return (
        <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <Field
                label={m.engine_name_label()}
                hint={m.engine_name_hint()}
                {...(invalid ? { error: m.engine_name_invalid() } : {})}
            >
                {(control) => (
                    <Input
                        {...control}
                        ref={input}
                        value={typed}
                        autoComplete="off"
                        placeholder={m.engine_name_placeholder()}
                        onChange={(event) => {
                            setTyped(event.target.value);
                        }}
                    />
                )}
            </Field>
            <div className={`flex flex-wrap gap-2 ${props.onCancel === undefined ? 'justify-start' : 'justify-end'}`}>
                {props.onCancel === undefined ? null : (
                    <Button variant="ghost" onClick={props.onCancel}>
                        {m.engine_name_cancel()}
                    </Button>
                )}
                <Button type="submit" variant="primary" loading={rename.isPending}>
                    {m.engine_name_save()}
                </Button>
            </div>
        </form>
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
