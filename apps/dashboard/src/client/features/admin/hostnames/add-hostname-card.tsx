import { Card, Form, FormField, FormSubmit, Input, useZodForm } from '@ptbk/ui';
import { useMemo } from 'react';
import { z } from 'zod';

import { m } from '../../../../paraglide/messages';
import { apiRoutes } from '../../../../shared/api/routes';
import { useApiClient } from '../../../api/api-client-context';
import { dataOrThrow, problemCode } from '../../../api/queries';
import { useAppMutation } from '../../../core/mutations';
import { adminHostnamesKey } from './hostname-queries';

const MAX_HOSTNAME_INPUT = 1024;
/** An Ed25519 signature: 64 bytes as unpadded base64url. */
const CLAIM_PATTERN = /^[A-Za-z0-9_-]{86}$/;

/** The add route's own problem codes; the common ones (step-up, rate limit…) get the shared handling. */
const ADD_ERRORS: Readonly<Record<string, () => string>> = {
    'invalid-hostname': () => m.admin_hostnames_error_invalid_hostname(),
    'reserved-domain': () => m.admin_hostnames_error_reserved(),
    taken: () => m.admin_hostnames_error_taken(),
    'bad-claim': () => m.admin_hostnames_error_bad_claim(),
    'limit-reached': () => m.admin_hostnames_error_limit(),
};

function addErrorMessage(error: unknown): string | undefined {
    const code = problemCode(error);
    return code !== null && Object.hasOwn(ADD_ERRORS, code) ? ADD_ERRORS[code]?.() : undefined;
}

/** The hostname and the engine's claim for it; the server normalises and verifies both before storing anything. */
export function AddHostnameCard(props: { readonly engineId: string }) {
    const api = useApiClient();
    const add = useAppMutation({
        mutationFn: async (body: { readonly hostname: string; readonly claimSig: string }) =>
            dataOrThrow(await api.call(apiRoutes.adminAddHostname, { params: { engineId: props.engineId }, body })),
        invalidates: [adminHostnamesKey(props.engineId)],
        successMessage: () => m.admin_hostnames_added(),
        errorMessage: addErrorMessage,
    });
    const schema = useMemo(
        () =>
            z.strictObject({
                hostname: z
                    .string()
                    .trim()
                    .min(1, { error: m.admin_hostnames_hostname_required() })
                    .max(MAX_HOSTNAME_INPUT, { error: m.admin_hostnames_error_invalid_hostname() }),
                claimSig: z.string().trim().regex(CLAIM_PATTERN, { error: m.admin_hostnames_claim_invalid() }),
            }),
        [],
    );
    const form = useZodForm({
        schema,
        defaultValues: { hostname: '', claimSig: '' },
        onSubmit: async (values, current) => {
            try {
                await add.mutateAsync(values);
                current.reset();
            } catch {
                // Reported in a toast by the mutation; the values stay so the admin can correct them.
            }
        },
    });
    return (
        <Card title={m.admin_hostnames_add_title()}>
            <Form form={form} className="flex flex-col gap-4">
                <FormField
                    form={form}
                    name="hostname"
                    label={m.admin_hostnames_add_hostname_label()}
                    hint={m.admin_hostnames_add_hostname_hint()}
                    required
                >
                    {({ text }) => <Input {...text} autoComplete="off" spellCheck={false} />}
                </FormField>
                <FormField
                    form={form}
                    name="claimSig"
                    label={m.admin_hostnames_add_claim_label()}
                    hint={m.admin_hostnames_add_claim_hint()}
                    required
                >
                    {({ text }) => <Input {...text} autoComplete="off" spellCheck={false} className="font-mono" />}
                </FormField>
                <div>
                    <FormSubmit form={form}>{m.admin_hostnames_add_submit()}</FormSubmit>
                </div>
            </Form>
        </Card>
    );
}
