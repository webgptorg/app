import {
    MAX_WALLET_FIELD_VALUE_LENGTH,
    MAX_WALLET_LABEL_LENGTH,
    MAX_WALLET_PASSWORD_LENGTH,
    MAX_WALLET_USERNAME_LENGTH,
} from '@ptbk/engine-api';
import type { ReadWalletRecord, ReadWalletRequest } from '@ptbk/engine-api';
import {
    Button,
    Dialog,
    Field,
    Form,
    FormField,
    FormSubmit,
    Input,
    SensitiveInput,
    useSensitiveInput,
    useZodForm,
} from '@ptbk/ui';
import type { SensitiveInputHandle } from '@ptbk/ui';
import { Eye, EyeOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { m } from '../../paraglide/messages';
import { OneTimeValue } from './one-time-value';
import type { LoginInput, WalletMutations } from './use-wallet-mutations';
import { siteName, toWalletOrigin } from './wallet-origin';

/** What the dialog saves: a new login, or a new password for a saved one; either may answer an agent's request. */
export interface LoginDialogTarget {
    readonly record?: ReadWalletRecord;
    readonly request?: ReadWalletRequest;
    /** What the member had typed before confirming with a passkey; never the password. */
    readonly resumed?: { readonly origin: string; readonly username: string; readonly label?: string };
}

const LoginForm = z.object({
    website: z
        .string()
        .trim()
        .refine((value) => toWalletOrigin(value) !== null, { error: () => m.wallet_website_invalid() }),
    username: z
        .string()
        .trim()
        .min(1, { error: () => m.wallet_username_required() })
        .max(MAX_WALLET_USERNAME_LENGTH, { error: () => m.wallet_too_long() }),
    label: z
        .string()
        .trim()
        .max(MAX_WALLET_LABEL_LENGTH, { error: () => m.wallet_too_long() }),
});

/** Reads a secret straight from its input and empties it, whatever happens next; the value never leaves otherwise. */
function take(handle: SensitiveInputHandle, max: number): OneTimeValue | 'missing' | 'too-long' {
    const raw = handle.read();
    handle.clear();
    if (raw.length === 0) return 'missing';
    if (raw.length > max) return 'too-long';
    return new OneTimeValue(raw);
}

/** A field the website asks for, masked like the password; it registers its own input so the form can read it once. */
function RequestedField({
    label,
    error,
    register,
}: {
    readonly label: string;
    readonly error: string | undefined;
    readonly register: (label: string, handle: SensitiveInputHandle | null) => void;
}) {
    const handle = useSensitiveInput();
    useEffect(() => {
        register(label, handle);
        return () => {
            register(label, null);
        };
    }, [label, handle, register]);
    return (
        <Field label={label} error={error} required>
            {(control) => <SensitiveInput {...control} handle={handle} />}
        </Field>
    );
}

export interface LoginDialogProps {
    readonly target: LoginDialogTarget;
    readonly onClose: () => void;
    readonly mutations: WalletMutations;
}

/**
 * Add or update one login. The username is visible; the password is masked until the owner reveals it, and only here:
 * no list, toast or request ever carries it back. Website, username and label live in the form store; the password and
 * requested fields never do (`SensitiveInput`, read once on submit).
 */
export function LoginDialog({ target, onClose, mutations }: LoginDialogProps) {
    const { record, request, resumed } = target;
    const password = useSensitiveInput();
    const [revealed, setRevealed] = useState(false);
    const [passwordError, setPasswordError] = useState<string | undefined>(undefined);
    const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
    const fieldHandles = useRef(new Map<string, SensitiveInputHandle>());
    const pending = useRef<Pick<LoginInput, 'password' | 'fields'> | null>(null);
    const requestedFields = request?.problem === 'field' ? request.fields : [];
    const registerField = useCallback((label: string, handle: SensitiveInputHandle | null) => {
        if (handle === null) fieldHandles.current.delete(label);
        else fieldHandles.current.set(label, handle);
    }, []);

    const form = useZodForm({
        schema: LoginForm,
        defaultValues: {
            website: resumed?.origin ?? record?.origin ?? request?.origin ?? '',
            username: resumed?.username ?? record?.username ?? request?.account ?? '',
            label: resumed?.label ?? record?.label ?? '',
        },
        onSubmit: async (values) => {
            const secrets = pending.current;
            pending.current = null;
            const origin = toWalletOrigin(values.website);
            if (secrets === null || origin === null) return;
            const label = values.label === '' || values.label === record?.label ? undefined : values.label;
            try {
                await mutations.save.mutateAsync({
                    ...(record === undefined ? {} : { recordId: record.id }),
                    origin,
                    username: values.username,
                    ...secrets,
                    ...(label === undefined ? {} : { label }),
                    ...(request === undefined ? {} : { requestId: request.id }),
                });
                form.reset();
                onClose();
            } catch {
                // The mutation reported it in a toast; the dialog stays open for another try with the password typed again.
            }
        },
    });

    // Runs before validation, so every problem shows at once; with a missing secret nothing is sent.
    const capture = () => {
        const typed = take(password, MAX_WALLET_PASSWORD_LENGTH);
        setPasswordError(
            typed === 'missing' ? m.wallet_password_required() : typed === 'too-long' ? m.wallet_too_long() : undefined,
        );
        const errors: Record<string, string> = {};
        const fields: { label: string; value: OneTimeValue }[] = [];
        for (const label of requestedFields) {
            const handle = fieldHandles.current.get(label);
            const value = handle === undefined ? 'missing' : take(handle, MAX_WALLET_FIELD_VALUE_LENGTH);
            if (value instanceof OneTimeValue) fields.push({ label, value });
            else errors[label] = value === 'missing' ? m.wallet_field_required() : m.wallet_too_long();
        }
        setFieldErrors(errors);
        pending.current =
            typed instanceof OneTimeValue && Object.keys(errors).length === 0
                ? { password: typed, ...(fields.length === 0 ? {} : { fields }) }
                : null;
    };

    const close = () => {
        pending.current = null;
        password.clear();
        for (const handle of fieldHandles.current.values()) handle.clear();
        onClose();
    };

    const site = siteName(record?.origin ?? request?.origin ?? '');
    return (
        <Dialog
            open
            onClose={close}
            title={record === undefined ? m.wallet_add_title() : m.wallet_update_title({ site })}
            description={m.wallet_form_body()}
        >
            <Form form={form} onSubmitCapture={capture} className="flex flex-col gap-4">
                {resumed === undefined ? null : <p className="text-sm">{m.wallet_resumed()}</p>}
                <FormField form={form} name="website" label={m.wallet_website_label()} required>
                    {(control) => (
                        <Input
                            {...control.text}
                            autoComplete="off"
                            spellCheck={false}
                            inputMode="url"
                            placeholder="github.com"
                            readOnly={record !== undefined}
                        />
                    )}
                </FormField>
                <FormField form={form} name="username" label={m.wallet_username_label()} required>
                    {(control) => (
                        <Input
                            {...control.text}
                            autoComplete="off"
                            autoCapitalize="off"
                            spellCheck={false}
                            maxLength={MAX_WALLET_USERNAME_LENGTH}
                        />
                    )}
                </FormField>
                <Field label={m.wallet_password_label()} error={passwordError} required>
                    {(control) => (
                        <div className="flex items-center gap-2">
                            <SensitiveInput {...control} handle={password} revealed={revealed} className="flex-1" />
                            <Button
                                variant="ghost"
                                aria-pressed={revealed}
                                onClick={() => {
                                    setRevealed((shown) => !shown);
                                }}
                            >
                                {revealed ? (
                                    <EyeOff aria-hidden className="size-4" />
                                ) : (
                                    <Eye aria-hidden className="size-4" />
                                )}
                                {revealed ? m.wallet_password_hide() : m.wallet_password_show()}
                            </Button>
                        </div>
                    )}
                </Field>
                {requestedFields.map((label) => (
                    <RequestedField key={label} label={label} error={fieldErrors[label]} register={registerField} />
                ))}
                <FormField form={form} name="label" label={m.wallet_label_label()} hint={m.wallet_label_hint()}>
                    {(control) => <Input {...control.text} autoComplete="off" maxLength={MAX_WALLET_LABEL_LENGTH} />}
                </FormField>
                <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" onClick={close}>
                        {m.wallet_cancel()}
                    </Button>
                    <FormSubmit form={form}>{m.wallet_save()}</FormSubmit>
                </div>
            </Form>
        </Dialog>
    );
}
