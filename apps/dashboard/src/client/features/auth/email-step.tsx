import { Banner, Button, Form, FormField, FormSubmit, Input, useZodForm } from '@ptbk/ui';
import { MailCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { z } from 'zod';

import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';

const MAX_EMAIL_LENGTH = 320;

type Sent =
    { readonly kind: 'form'; readonly failure: string | null } | { readonly kind: 'sent'; readonly email: string };

/**
 * The email step of sign-up and recovery. The API answers the same for every address, and so does this screen: it
 * never says whether an account exists. Only failures that are about the request itself (rate limit, network) show.
 */
export function EmailStep(props: { readonly purpose: 'signup' | 'recovery'; readonly submitLabel: string }) {
    const api = useApiClient();
    const [state, setState] = useState<Sent>({ kind: 'form', failure: null });
    const schema = useMemo(
        () =>
            z.strictObject({
                email: z
                    .string()
                    .trim()
                    .min(1, { error: m.email_required() })
                    .max(MAX_EMAIL_LENGTH, { error: m.email_invalid() })
                    .pipe(z.email({ error: m.email_invalid() })),
            }),
        [],
    );
    const form = useZodForm({
        schema,
        defaultValues: { email: '' },
        onSubmit: async ({ email }) => {
            const route = props.purpose === 'signup' ? apiRoutes.signupStart : apiRoutes.recoveryRequest;
            const outcome = await api.call(route, { body: { email } });
            if (outcome.kind === 'ok') {
                setState({ kind: 'sent', email });
                return;
            }
            const rateLimited = outcome.kind === 'problem' && outcome.code === 'rate-limited';
            setState({ kind: 'form', failure: rateLimited ? m.api_error_rate_limited() : m.api_error_unreachable() });
        },
    });

    if (state.kind === 'sent') {
        return (
            <div className="flex flex-col gap-4" role="status">
                <MailCheck aria-hidden className="size-8 text-accent" />
                <h2 className="font-display text-xl font-semibold">{m.email_sent_title()}</h2>
                <p>
                    {props.purpose === 'signup'
                        ? m.email_sent_signup({ email: state.email })
                        : m.email_sent_recovery({ email: state.email })}
                </p>
                <p className="text-sm text-text-muted">{m.email_sent_hint()}</p>
                <div>
                    <Button
                        onClick={() => {
                            form.reset();
                            setState({ kind: 'form', failure: null });
                        }}
                    >
                        {m.email_use_another()}
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <Form form={form} className="flex flex-col gap-4">
            {state.failure === null ? null : <Banner tone="danger">{state.failure}</Banner>}
            <FormField form={form} name="email" label={m.email_label()} required>
                {({ text }) => <Input {...text} type="email" autoComplete="email" inputMode="email" />}
            </FormField>
            <FormSubmit form={form}>{props.submitLabel}</FormSubmit>
        </Form>
    );
}
