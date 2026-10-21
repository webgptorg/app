import { Button, Dialog, useSensitiveInput } from '@ptbk/ui';
import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { m } from '../../paraglide/messages';
import { takeValue, ValueField } from './secret-value-field';
import type { SecretMutations, SecretTarget } from './use-secret-mutations';

export interface ReplaceSecretDialogProps {
    readonly secret: SecretTarget;
    readonly onClose: () => void;
    readonly mutations: SecretMutations;
}

/** Only a new value; the old one is never shown, so there is nothing to compare against. */
export function ReplaceSecretDialog({ secret, onClose, mutations }: ReplaceSecretDialogProps) {
    const formId = useId();
    const handle = useSensitiveInput();
    const [valueError, setValueError] = useState<string | undefined>(undefined);

    const submit = (event: SyntheticEvent<HTMLFormElement>) => {
        event.preventDefault();
        const taken = takeValue(handle);
        if ('error' in taken) {
            setValueError(taken.error);
            return;
        }
        setValueError(undefined);
        mutations.replace.mutate({ ...secret, value: taken.value }, { onSuccess: onClose });
    };

    return (
        <Dialog
            open
            onClose={() => {
                handle.clear();
                onClose();
            }}
            title={m.secrets_replace_title({ name: secret.name })}
            description={m.secrets_replace_body()}
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        {m.secrets_cancel()}
                    </Button>
                    <Button type="submit" form={formId} variant="primary" loading={mutations.replace.isPending}>
                        {m.secrets_replace()}
                    </Button>
                </>
            }
        >
            <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
                <ValueField handle={handle} error={valueError} />
            </form>
        </Dialog>
    );
}
