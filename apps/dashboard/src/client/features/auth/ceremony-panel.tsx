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
    readonly reopen: (() => void) | null;
    readonly footer?: ReactNode;
    /** A calm picture above the title, e.g. the brand robot on sign-in. Decorative. */
    readonly illustration?: ReactNode;
}) {
    const failed = props.state.kind === 'failed';
    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                {props.illustration === undefined ? null : (
                    <div aria-hidden="true" className="mb-2 flex">
                        {props.illustration}
                    </div>
                )}
                <h1 className="text-2xl font-semibold tracking-display">{props.title}</h1>
                <div className="flex flex-col gap-2 text-sm text-text-muted">{props.description}</div>
            </div>
            {props.state.kind === 'failed' ? (
                <Banner tone="danger" title={m.passkey_error_title()}>
                    {ceremonyFailureMessage(props.state.failure, props.kind)}
                </Banner>
            ) : null}
            {/* The page's one action: large and centred, still the soft primary wash (docs/design/ui.md, Buttons). */}
            <div className="flex justify-center py-2">
                <Button
                    variant="primary"
                    size="lg"
                    loading={props.state.kind === 'running' && props.reopen === null}
                    onClick={props.reopen ?? props.onStart}
                >
                    <KeyRound aria-hidden className="size-4" />
                    {props.reopen !== null
                        ? m.passkey_reopen_prompt()
                        : failed
                          ? m.passkey_try_again()
                          : props.actionLabel}
                </Button>
            </div>
            {props.footer}
        </div>
    );
}
