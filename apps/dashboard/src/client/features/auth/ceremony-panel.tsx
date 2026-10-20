import { Banner, Button } from '@ptbk/ui';
import { KeyRound } from 'lucide-react';
import type { ReactNode } from 'react';

import { m } from '../../../paraglide/messages';
import { ceremonyFailureMessage } from '../passkeys/ceremony-messages';
import type { CeremonyKind } from '../passkeys/ceremony-messages';
import type { CeremonyState } from '../passkeys/use-ceremony';

/** One passkey step: what happens, the button that starts it, and after a failure the reason and a retry. */
export function CeremonyPanel(props: {
    readonly title: string;
    readonly description: ReactNode;
    readonly actionLabel: string;
    readonly kind: CeremonyKind;
    readonly state: CeremonyState;
    readonly onStart: () => void;
    readonly footer?: ReactNode;
}) {
    const failed = props.state.kind === 'failed';
    return (
        <div className="flex flex-col gap-4">
            <h1 className="font-display text-2xl font-semibold">{props.title}</h1>
            <div className="flex flex-col gap-2 text-text-muted">{props.description}</div>
            {props.state.kind === 'failed' ? (
                <Banner tone="danger" title={m.passkey_error_title()}>
                    {ceremonyFailureMessage(props.state.failure, props.kind)}
                </Banner>
            ) : null}
            <Button
                variant="primary"
                loading={props.state.kind === 'running'}
                onClick={props.onStart}
                className="w-full"
            >
                <KeyRound aria-hidden className="me-2 size-4" />
                {failed ? m.passkey_try_again() : props.actionLabel}
            </Button>
            {props.footer}
        </div>
    );
}
