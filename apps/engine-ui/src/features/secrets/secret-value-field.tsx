import { MAX_SECRET_VALUE_LENGTH } from '@ptbk/engine-api';
import { Field, SensitiveInput } from '@ptbk/ui';
import type { SensitiveInputHandle } from '@ptbk/ui';

import { m } from '../../paraglide/messages';
import { OneTimeValue } from './one-time-value';

/**
 * Reads the value straight from the input and empties it, whatever happens next. A missing or over-long value is
 * reported without the value ever leaving the input.
 */
export function takeValue(handle: SensitiveInputHandle): { readonly value: OneTimeValue } | { readonly error: string } {
    const raw = handle.read();
    handle.clear();
    if (raw.length === 0) return { error: m.secrets_value_required() };
    if (raw.length > MAX_SECRET_VALUE_LENGTH) return { error: m.secrets_value_too_long() };
    return { value: new OneTimeValue(raw) };
}

export function ValueField({
    handle,
    error,
}: {
    readonly handle: SensitiveInputHandle;
    readonly error: string | undefined;
}) {
    return (
        <Field label={m.secrets_value_label()} hint={m.secrets_value_hint()} error={error} required>
            {(control) => <SensitiveInput {...control} handle={handle} />}
        </Field>
    );
}
