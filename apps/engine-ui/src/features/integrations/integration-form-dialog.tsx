import type { AgentId, ReadIntegration } from '@ptbk/engine-api';
import {
    applyServerErrors,
    Banner,
    Button,
    ConfirmDialog,
    Dialog,
    Form,
    FormField,
    FormSubmit,
    Input,
    Select,
    Textarea,
    useZodForm,
} from '@ptbk/ui';
import type { ServerFieldError } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { agentListQueryOptions } from '../agents/agents-queries';
import {
    formatSecretNames,
    IntegrationFormSchema,
    MAX_SECRET_NAMES,
    parseSecretNames,
    toFormErrors,
} from './integration-form';
import type { CreatableKind, IntegrationFormValues } from './integration-form';
import type { IntegrationMutations } from './use-integration-mutations';

/** The pickers list the first page of agents and secrets by name; the engine pages beyond that. */
const PICKER_LIMIT = 100;

export type IntegrationFormMode =
    | { readonly kind: 'create'; readonly integrationKind: CreatableKind; readonly agentId?: AgentId }
    | { readonly kind: 'edit'; readonly integration: ReadIntegration };

export interface IntegrationFormDialogProps {
    readonly mode: IntegrationFormMode;
    readonly mutations: IntegrationMutations;
    readonly onClose: () => void;
}

function initialValues(mode: IntegrationFormMode): IntegrationFormValues {
    if (mode.kind === 'create') {
        return {
            kind: mode.integrationKind,
            name: '',
            url: '',
            repository: '',
            agentId: mode.agentId ?? '',
            secretNames: '',
        };
    }
    const { integration } = mode;
    return {
        kind: integration.kind,
        name: integration.name,
        url: integration.kind === 'mcp-server' ? integration.config.url : '',
        repository: integration.kind === 'repository' ? integration.config.repository : '',
        agentId: integration.agentId ?? '',
        secretNames: formatSecretNames(integration.secretRefs.map(({ name }) => name)),
    };
}

function titleOf(mode: IntegrationFormMode): string {
    if (mode.kind === 'edit') return m.integration_edit_title({ name: mode.integration.name });
    return mode.integrationKind === 'mcp-server' ? m.integrations_add_mcp() : m.integrations_add_repository();
}

/**
 * Adds an MCP server or a GitHub repository, or edits an integration's name, URL and secret references. Secrets are
 * referenced by name only (picked from secret metadata with `wallet.read`, typed without it); there is no value
 * field, because values are entered on the Secrets page and go straight to the engine's wallet from there.
 */
export function IntegrationFormDialog({ mode, mutations, onClose }: IntegrationFormDialogProps) {
    const engineApi = useEngineApi();
    const [unmatched, setUnmatched] = useState<readonly ServerFieldError[]>([]);
    const agents = useQuery({
        ...agentListQueryOptions(engineApi, { sort: 'name', limit: PICKER_LIMIT }),
        enabled: mode.kind === 'create',
    });
    const form = useZodForm({
        schema: IntegrationFormSchema,
        defaultValues: initialValues(mode),
        onSubmit: async (values, current) => {
            setUnmatched([]);
            const secretNames = parseSecretNames(values.secretNames);
            try {
                if (mode.kind === 'edit') {
                    const { integration } = mode;
                    await mutations.update.mutateAsync({
                        id: integration.id,
                        name: integration.name,
                        body: {
                            ...(values.name === integration.name ? {} : { name: values.name }),
                            ...(integration.kind === 'mcp-server' && values.url !== integration.config.url
                                ? { url: values.url }
                                : {}),
                            secretNames,
                        },
                    });
                } else {
                    const agentId = values.agentId === '' ? null : (values.agentId as AgentId);
                    await mutations.create.mutateAsync(
                        mode.integrationKind === 'mcp-server'
                            ? { kind: 'mcp-server', name: values.name, agentId, url: values.url, secretNames }
                            : {
                                  kind: 'repository',
                                  name: values.name,
                                  agentId,
                                  provider: 'github',
                                  repository: values.repository,
                                  secretNames,
                              },
                    );
                }
                onClose();
            } catch (error) {
                // The mutation reported it in a toast; field errors also go next to their fields.
                const failure = classifyApiError(error);
                if (failure.kind !== 'problem') return;
                if (failure.problem.code === 'name-taken') {
                    applyServerErrors(current, [{ path: 'name', message: m.integration_name_taken_field() }]);
                } else if (failure.problem.errors !== undefined) {
                    setUnmatched(applyServerErrors(current, toFormErrors(failure.problem.errors)));
                }
            }
        },
    });
    const integrationKind = mode.kind === 'create' ? mode.integrationKind : mode.integration.kind;
    const [confirmingDiscard, setConfirmingDiscard] = useState(false);
    // Esc, the backdrop and Cancel all land here, so typed work is never dropped without asking.
    const requestClose = () => {
        if (form.state.isDefaultValue) onClose();
        else setConfirmingDiscard(true);
    };

    return (
        <Dialog open onClose={requestClose} title={titleOf(mode)} description={m.integration_form_body()}>
            <Form form={form} className="flex flex-col gap-4">
                {unmatched.length === 0 ? null : (
                    <Banner tone="danger">
                        <ul>
                            {unmatched.map((error) => (
                                <li key={`${error.path}:${error.message}`}>{error.message}</li>
                            ))}
                        </ul>
                    </Banner>
                )}
                <FormField form={form} name="name" label={m.integration_name_label()} required>
                    {(control) => <Input {...control.text} autoComplete="off" maxLength={128} />}
                </FormField>
                {integrationKind === 'mcp-server' ? (
                    <FormField
                        form={form}
                        name="url"
                        label={m.integration_url_label()}
                        hint={m.integration_url_hint()}
                        required
                    >
                        {(control) => (
                            <Input {...control.text} type="url" inputMode="url" autoComplete="off" spellCheck={false} />
                        )}
                    </FormField>
                ) : null}
                {integrationKind === 'repository' && mode.kind === 'create' ? (
                    <FormField
                        form={form}
                        name="repository"
                        label={m.integration_repository_label()}
                        hint={m.integration_repository_hint()}
                        required
                    >
                        {(control) => <Input {...control.text} autoComplete="off" spellCheck={false} />}
                    </FormField>
                ) : null}
                {mode.kind === 'create' ? (
                    <FormField form={form} name="agentId" label={m.integration_agent_label()}>
                        {(control) => (
                            <Select {...control.text}>
                                <option value="">{m.integration_all_agents()}</option>
                                {mode.agentId === undefined ||
                                (agents.data?.items ?? []).some(({ id }) => id === mode.agentId) ? null : (
                                    <option value={mode.agentId}>{mode.agentId}</option>
                                )}
                                {(agents.data?.items ?? []).map((agent) => (
                                    <option key={agent.id} value={agent.id}>
                                        {agent.name}
                                    </option>
                                ))}
                            </Select>
                        )}
                    </FormField>
                ) : null}
                <SecretNamesField form={form} />
                <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" onClick={requestClose}>
                        {m.integration_cancel()}
                    </Button>
                    <FormSubmit form={form}>
                        {mode.kind === 'create' ? m.integration_add() : m.integration_save()}
                    </FormSubmit>
                </div>
            </Form>
            <ConfirmDialog
                open={confirmingDiscard}
                onClose={() => {
                    setConfirmingDiscard(false);
                }}
                onConfirm={onClose}
                title={m.integration_discard_title()}
                description={m.integration_discard_body()}
                confirmLabel={m.integration_discard()}
                tone="danger"
            />
        </Dialog>
    );
}

type IntegrationForm = ReturnType<typeof useZodForm<typeof IntegrationFormSchema>>;

/** Names typed by hand: the engine sets their values itself, and this API lists no tool secrets. */
function SecretNamesField({ form }: { readonly form: IntegrationForm }) {
    return (
        <FormField
            form={form}
            name="secretNames"
            label={m.integration_secret_names_label()}
            hint={m.integration_secret_names_typed_hint({ max: MAX_SECRET_NAMES })}
        >
            {(control) => <Textarea {...control.text} rows={2} autoComplete="off" spellCheck={false} />}
        </FormField>
    );
}
