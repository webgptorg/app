import { Banner, Button, Form, FormField, FormSubmit, Input, useZodForm } from '@ptbk/ui';
import { MailCheck } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { z } from 'zod';

import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { useBrowser } from '../../core/browser';

const MAX_EMAIL_LENGTH = 320;
/** Matches the per-address limit's pace (3 an hour), so a resend is offered once a first message had time to land. */
export const RESEND_AFTER_MS = 60_000;
const SECOND_MS = 1000;
/** Stands in for the address in a translated sentence, so the address can be set apart wherever the language puts it. */
const ADDRESS_SLOT = '\u0000';

type Purpose = 'continue' | 'recovery';

type Sent =
    | { readonly kind: 'form'; readonly failure: string | null }
    | {
          readonly kind: 'sent';
          readonly email: string;
          readonly sentAt: number;
          readonly resent: boolean;
          readonly failure: string | null;
      };

type Outcome = { readonly kind: 'sent' } | { readonly kind: 'failed'; readonly message: string };

function useSendLink(purpose: Purpose): (email: string) => Promise<Outcome> {
    const api = useApiClient();
    return async (email) => {
        const route = purpose === 'continue' ? apiRoutes.signupStart : apiRoutes.recoveryRequest;
        const outcome = await api.call(route, { body: { email } });
        if (outcome.kind === 'ok') {
            return { kind: 'sent' };
        }
        const rateLimited = outcome.kind === 'problem' && outcome.code === 'rate-limited';
        return { kind: 'failed', message: rateLimited ? m.api_error_rate_limited() : m.api_error_unreachable() };
    };
}

/** Whole seconds until `until`, ticking from the injected clock; 0 once it has passed. */
function useSecondsLeft(until: number): number {
    const { now } = useBrowser();
    const [current, setCurrent] = useState(now);
    const left = Math.max(0, Math.ceil((until - current) / SECOND_MS));
    useEffect(() => {
        if (left === 0) {
            return undefined;
        }
        const timer = setInterval(() => {
            setCurrent(now());
        }, SECOND_MS);
        return () => {
            clearInterval(timer);
        };
    }, [left, now]);
    return left;
}

/**
 * An address may hold a hyphen, where browsers like to break the line ("ada-" / "lovelace@…"). Each half stays
 * whole unless it alone is wider than the card.
 */
function Address(props: { readonly email: string }) {
    const at = props.email.lastIndexOf('@');
    const local = props.email.slice(0, at);
    const domain = props.email.slice(at);
    return (
        <strong className="font-medium">
            <span className="inline-block max-w-full wrap-anywhere">{local}</span>
            <wbr />
            <span className="inline-block max-w-full wrap-anywhere">{domain}</span>
        </strong>
    );
}

function SentMessage(props: { readonly purpose: Purpose; readonly email: string }) {
    const sentence = props.purpose === 'continue' ? m.email_sent_continue : m.email_sent_recovery;
    const [before = '', after = ''] = sentence({ email: ADDRESS_SLOT }).split(ADDRESS_SLOT);
    return (
        <p>
            {before}
            <Address email={props.email} />
            {after}
        </p>
    );
}

/** Keyed by the last send, so every send starts a fresh minute from the clock's current reading. */
function ResendButton(props: { readonly sentAt: number; readonly onResend: () => Promise<void> }) {
    const secondsLeft = useSecondsLeft(props.sentAt + RESEND_AFTER_MS);
    const [resending, setResending] = useState(false);
    return (
        <Button
            variant="secondary"
            disabled={secondsLeft > 0}
            loading={resending}
            onClick={() => {
                setResending(true);
                void props.onResend().finally(() => {
                    setResending(false);
                });
            }}
        >
            {secondsLeft > 0 ? m.email_send_again_in({ seconds: secondsLeft }) : m.email_send_again()}
        </Button>
    );
}

function SentState(props: {
    readonly purpose: Purpose;
    readonly state: Extract<Sent, { readonly kind: 'sent' }>;
    readonly onResend: () => Promise<void>;
    readonly onUseAnother: () => void;
}) {
    const headingRef = useRef<HTMLHeadingElement>(null);
    // The form that had focus is gone; the new heading takes it, so keyboard and screen reader users land on the news.
    useEffect(() => {
        headingRef.current?.focus();
    }, []);
    return (
        <div className="flex flex-col gap-4">
            <MailCheck aria-hidden className="size-6 text-text-muted" />
            <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-display outline-none">
                {m.email_sent_title()}
            </h1>
            <div role="status" className="flex flex-col gap-4 text-sm">
                <SentMessage purpose={props.purpose} email={props.state.email} />
                {props.state.resent ? <p className="text-sm">{m.email_sent_again()}</p> : null}
            </div>
            {props.state.failure === null ? null : <Banner tone="danger">{props.state.failure}</Banner>}
            <p className="text-sm text-text-muted">{m.email_sent_hint()}</p>
            <div className="flex flex-wrap gap-3">
                <ResendButton key={props.state.sentAt} sentAt={props.state.sentAt} onResend={props.onResend} />
                <Button variant="ghost" onClick={props.onUseAnother}>
                    {m.email_use_another()}
                </Button>
            </div>
        </div>
    );
}

/**
 * The email step of Continue and recovery, heading included, so the sent state replaces the whole card. The API answers
 * the same for every address, and so does this screen: it never says whether an account exists. Only failures that
 * are about the request itself (rate limit, network) show.
 */
export function EmailStep(props: {
    readonly purpose: Purpose;
    readonly title: string;
    readonly intro: ReactNode;
    readonly submitLabel: string;
    readonly footer: ReactNode;
    /** Under the email field, e.g. what a passkey is. */
    readonly hint?: ReactNode;
    /** Rendered with the form only, so whatever it starts (the passkey autofill) lives exactly as long as the field. */
    readonly formAddon?: ReactNode;
    /** Under the submit button, with the form only (Continue: "Use a passkey"). */
    readonly secondaryAction?: ReactNode;
    /** Once the email went out, so a page can drop what no longer applies (Continue: a failed passkey). */
    readonly onSent?: () => void;
    readonly autoComplete?: string;
    /** A calm picture above the title, as on the other auth screens. Decorative. */
    readonly illustration?: ReactNode;
}) {
    const { now } = useBrowser();
    const sendLink = useSendLink(props.purpose);
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
            const outcome = await sendLink(email);
            if (outcome.kind === 'sent') {
                props.onSent?.();
            }
            setState(
                outcome.kind === 'sent'
                    ? { kind: 'sent', email, sentAt: now(), resent: false, failure: null }
                    : { kind: 'form', failure: outcome.message },
            );
        },
    });

    if (state.kind === 'sent') {
        return (
            <SentState
                purpose={props.purpose}
                state={state}
                onResend={async () => {
                    const outcome = await sendLink(state.email);
                    setState(
                        outcome.kind === 'sent'
                            ? { ...state, sentAt: now(), resent: true, failure: null }
                            : { ...state, resent: false, failure: outcome.message },
                    );
                }}
                onUseAnother={() => {
                    form.reset();
                    setState({ kind: 'form', failure: null });
                }}
            />
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2 text-sm">
                {props.illustration === undefined ? null : (
                    <div aria-hidden="true" className="mb-2 flex">
                        {props.illustration}
                    </div>
                )}
                <h1 className="text-2xl font-semibold tracking-display">{props.title}</h1>
                {props.intro}
            </div>
            <Form form={form} className="flex flex-col gap-4">
                {state.failure === null ? null : <Banner tone="danger">{state.failure}</Banner>}
                <FormField form={form} name="email" label={m.email_label()} required>
                    {({ text }) => (
                        <Input {...text} type="email" autoComplete={props.autoComplete ?? 'email'} inputMode="email" />
                    )}
                </FormField>
                {props.hint}
                {props.formAddon}
                <FormSubmit form={form} size="lg">
                    {props.submitLabel}
                </FormSubmit>
                {props.secondaryAction}
            </Form>
            {props.footer}
        </div>
    );
}
