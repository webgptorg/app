import type { AgentId } from '@ptbk/engine-api';
import { Button, Dialog, Form, FormField, FormSubmit, Input, Select, useSensitiveInput, useZodForm } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { z } from 'zod';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { agentListQueryOptions } from '../agents/agents-queries';
import type { OneTimeValue } from './one-time-value';
import { SECRET_SCOPE_KINDS } from './secret-list-search';
import { takeValue, ValueField } from './secret-value-field';
import type { SecretMutations } from './use-secret-mutations';

/** The agent picker lists the first page of agents by name; the engine pages beyond that. */
const AGENT_PICKER_LIMIT = 100;

const CreateSecretForm = z
    .object({
        name: z
            .string()
            .trim()
            .min(1, { error: () => m.secrets_name_required() })
            .max(128, { error: () => m.secrets_name_too_long() }),
        scope: z.enum(SECRET_SCOPE_KINDS),
        agentId: z.string(),
    })
    .superRefine((values, context) => {
        if (values.scope === 'agent' && values.agentId === '') {
            context.addIssue({ code: 'custom', path: ['agentId'], message: m.secrets_agent_required() });
        }
    });

export interface CreateSecretDialogProps {
    readonly onClose: () => void;
    readonly mutations: SecretMutations;
}

/** Name and scope live in the form store; the value never does (`SensitiveInput`, read once on submit). */
export function CreateSecretDialog({ onClose, mutations }: CreateSecretDialogProps) {
    const engineApi = useEngineApi();
    const handle = useSensitiveInput();
    const pending = useRef<OneTimeValue | null>(null);
    const [valueError, setValueError] = useState<string | undefined>(undefined);
    const agents = useQuery({
        ...agentListQueryOptions(engineApi, { sort: 'name', limit: AGENT_PICKER_LIMIT }),
    });
    const form = useZodForm({
        schema: CreateSecretForm,
        defaultValues: { name: '', scope: 'engine', agentId: '' },
        onSubmit: async (values) => {
            const value = pending.current;
            pending.current = null;
            if (value === null) return;
            try {
                await mutations.create.mutateAsync({
                    name: values.name,
                    scope:
                        values.scope === 'agent'
                            ? { kind: 'agent', agentId: values.agentId as AgentId }
                            : { kind: 'engine' },
                    value,
                });
                form.reset();
                onClose();
            } catch {
                // The mutation reported it in a toast; the dialog stays open for another try with a new value.
            }
        },
    });

    const capture = () => {
        const taken = takeValue(handle);
        // The name and scope are still validated, so every problem shows at once; without a value nothing is sent.
        pending.current = 'error' in taken ? null : taken.value;
        setValueError('error' in taken ? taken.error : undefined);
    };

    return (
        <Dialog
            open
            onClose={() => {
                pending.current = null;
                handle.clear();
                setValueError(undefined);
                onClose();
            }}
            title={m.secrets_new_title()}
            description={m.secrets_new_body()}
        >
            <Form form={form} onSubmitCapture={capture} className="flex flex-col gap-4">
                <FormField form={form} name="name" label={m.secrets_name_label()} hint={m.secrets_name_hint()} required>
                    {(control) => <Input {...control.text} autoComplete="off" spellCheck={false} maxLength={128} />}
                </FormField>
                <FormField form={form} name="scope" label={m.secrets_scope_label()}>
                    {(control) => (
                        <Select {...control.text}>
                            <option value="engine">{m.secrets_scope_option_engine()}</option>
                            <option value="agent">{m.secrets_scope_option_agent()}</option>
                        </Select>
                    )}
                </FormField>
                <form.Subscribe selector={(state) => state.values.scope}>
                    {(scope) =>
                        scope === 'agent' ? (
                            <FormField form={form} name="agentId" label={m.secrets_agent_label()} required>
                                {(control) => (
                                    <Select {...control.text}>
                                        <option value="">{m.secrets_agent_choose()}</option>
                                        {(agents.data?.items ?? []).map((agent) => (
                                            <option key={agent.id} value={agent.id}>
                                                {agent.name}
                                            </option>
                                        ))}
                                    </Select>
                                )}
                            </FormField>
                        ) : null
                    }
                </form.Subscribe>
                <ValueField handle={handle} error={valueError} />
                <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" onClick={onClose}>
                        {m.secrets_cancel()}
                    </Button>
                    <FormSubmit form={form}>{m.secrets_create()}</FormSubmit>
                </div>
            </Form>
        </Dialog>
    );
}
