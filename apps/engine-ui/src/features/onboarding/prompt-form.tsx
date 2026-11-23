import { MAX_ONBOARDING_SECRET_LENGTH } from '@ptbk/engine-api';
import type {
    OnboardingAlternative,
    OnboardingAnswer,
    OnboardingDetail,
    OnboardingPrompt,
    ReadOnboardingPrompt,
    UnsupportedOnboardingPrompt,
} from '@ptbk/engine-api';
import { Banner, Button, buttonClassName, CopyButton, ExternalLink, Input, Spinner, Textarea } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ExternalLink as ExternalLinkIcon } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, SubmitEvent } from 'react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { engineInfoQueryOptions } from '../engine/engine-queries';

import { m } from '../../paraglide/messages';
import { OneTimeValue } from '../wallet/one-time-value';
import { OnboardingUpload } from './onboarding-upload';
import type { UploadedFile } from './onboarding-upload';

type HarnessLoginPrompt = Extract<OnboardingPrompt, { kind: 'harness-login' }>;
type SecretPrompt = Extract<OnboardingPrompt, { kind: 'secret' }>;

/**
 * An answer on its way to the engine. A secret travels as a `OneTimeValue` that is emptied when the request is built,
 * so the mutation's retained variables never hold it.
 */
export type PromptAnswer =
    Exclude<OnboardingAnswer, { kind: 'secret' }> | { readonly kind: 'secret'; readonly value: OneTimeValue };

interface PromptActions {
    readonly busy: boolean;
    readonly onAnswer: (answer: PromptAnswer) => void;
    readonly onBack: () => void;
    readonly onAlternative: (alternativeId: string) => void;
}

type PromptFormProps<Prompt> = PromptActions & { readonly prompt: Prompt };

/**
 * One prompt as the engine sent it. Its texts are the engine's and render as plain text. Only the kind and its fields
 * decide what renders, never the step's title or position, so the engine may ask its steps in any order.
 */
export function PromptForm({ prompt, ...actions }: PromptFormProps<ReadOnboardingPrompt>) {
    switch (prompt.kind) {
        case 'text':
            return <TextPrompt prompt={prompt} {...actions} />;
        case 'choice':
            return <ChoicePrompt prompt={prompt} {...actions} />;
        case 'confirm':
            return (
                <Frame
                    prompt={prompt}
                    {...actions}
                    answers={
                        <>
                            <Button
                                size="lg"
                                variant="secondary"
                                disabled={actions.busy}
                                onClick={() => {
                                    actions.onAnswer({ kind: 'confirm', confirmed: false });
                                }}
                            >
                                {prompt.declineLabel}
                            </Button>
                            <Button
                                size="lg"
                                variant="primary"
                                loading={actions.busy}
                                onClick={() => {
                                    actions.onAnswer({ kind: 'confirm', confirmed: true });
                                }}
                            >
                                {prompt.confirmLabel}
                            </Button>
                        </>
                    }
                >
                    <Question prompt={prompt} />
                </Frame>
            );
        case 'upload':
            return <UploadPrompt prompt={prompt} {...actions} />;
        case 'secret':
            return <SecretPromptForm prompt={prompt} {...actions} />;
        case 'harness-login':
            return <HarnessLogin prompt={prompt} {...actions} />;
        case 'unsupported':
            return <UnsupportedPrompt prompt={prompt} />;
    }
}

/**
 * The engine's refusal of the last answer, the step's actions and its other ways through, around the controls of one
 * prompt. The actions sit as in the agent wizard: Back on the start side, the way forward on the end side, so the step's
 * one main action is always in the same place.
 */
function Frame({
    prompt,
    busy,
    onBack,
    onAlternative,
    submit,
    onSubmit,
    answers,
    children,
}: Omit<PromptActions, 'onAnswer'> & {
    readonly prompt: OnboardingPrompt;
    /** A Continue button that submits the form; prompts that answer by their own buttons give `answers` instead. */
    readonly submit?: { readonly disabled: boolean };
    readonly onSubmit?: () => void;
    readonly answers?: ReactNode;
    readonly children: ReactNode;
}) {
    const handle = (event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit?.();
    };
    const forward =
        answers ??
        (submit === undefined ? null : (
            <Button
                type="submit"
                size="lg"
                variant="primary"
                loading={busy}
                disabled={submit.disabled}
                className="gap-2"
            >
                {m.onboarding_continue()}
                <ArrowRight aria-hidden className="size-4" />
            </Button>
        ));
    return (
        <form className="flex flex-col gap-6" onSubmit={handle} noValidate>
            {children}
            {prompt.error === null ? null : <Banner tone="danger">{prompt.error}</Banner>}
            {forward === null && !prompt.canGoBack ? null : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                    {prompt.canGoBack ? (
                        <Button size="lg" variant="ghost" disabled={busy} onClick={onBack} className="-ms-3 gap-2">
                            <ArrowLeft aria-hidden className="size-4" />
                            {m.onboarding_back()}
                        </Button>
                    ) : null}
                    {forward === null ? null : (
                        <div className="ms-auto flex flex-wrap justify-end gap-2">{forward}</div>
                    )}
                </div>
            )}
            <Alternatives alternatives={prompt.alternatives} busy={busy} onAlternative={onAlternative} />
        </form>
    );
}

/** The question with the engine's hint and facts under it, where the question does not label a single field. */
function Question({ prompt }: { readonly prompt: OnboardingPrompt }) {
    return (
        <div className="flex flex-col gap-1.5">
            <p className="text-base [overflow-wrap:anywhere]">{prompt.question}</p>
            {prompt.hint === null ? null : <p className="text-sm text-text-muted">{prompt.hint}</p>}
            <PromptDetails details={prompt.details} />
        </div>
    );
}

/** The engine's facts for this step, e.g. the summary a final confirm asks about: a quiet label and value list. */
function PromptDetails({ details }: { readonly details: readonly OnboardingDetail[] }) {
    if (details.length === 0) return null;
    return (
        <dl className="mt-4 flex flex-col divide-y divide-hairline border-y border-hairline text-sm">
            {details.map((detail, index) => (
                // Labels may repeat; the engine's order is all that tells them apart.
                <div key={index} className="flex flex-col gap-0.5 py-3 sm:flex-row sm:gap-6">
                    <dt className="shrink-0 text-text-muted [overflow-wrap:anywhere] sm:w-40">{detail.label}</dt>
                    <dd className="min-w-0 whitespace-pre-line [overflow-wrap:anywhere]">{detail.text}</dd>
                </div>
            ))}
        </dl>
    );
}

/**
 * Other ways through the step. One the engine presents next is a button; one with `href` is a page of the engine's own
 * (e.g. its sign-in terminal) that opens in a new tab and is never sent. Coming back to this tab refetches the state,
 * so the page moves on once that page did its part.
 */
function Alternatives({
    alternatives,
    busy,
    onAlternative,
}: {
    readonly alternatives: readonly OnboardingAlternative[];
    readonly busy: boolean;
    readonly onAlternative: (alternativeId: string) => void;
}) {
    if (alternatives.length === 0) return null;
    return (
        <div className="flex flex-col gap-3 border-t border-hairline pt-5">
            <p className="meta">{m.onboarding_alternatives()}</p>
            <ul className="flex flex-col gap-4">
                {alternatives.map((alternative) => (
                    <li key={alternative.id} className="flex flex-col items-start gap-1">
                        {alternative.href === null ? (
                            <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                    onAlternative(alternative.id);
                                }}
                            >
                                {alternative.label}
                            </Button>
                        ) : (
                            // The reader admits only a path on the engine's own origin here.
                            <a
                                href={alternative.href}
                                target="_blank"
                                rel="noopener"
                                className={buttonClassName('secondary', 'sm', 'gap-1.5 no-underline')}
                            >
                                {alternative.label}
                                <ExternalLinkIcon aria-hidden className="size-3.5" />
                                <span className="sr-only">{` ${m.onboarding_alternative_new_tab_sr()}`}</span>
                            </a>
                        )}
                        {alternative.description === null ? null : (
                            <p className="text-xs [overflow-wrap:anywhere] text-text-muted">
                                {alternative.description}
                            </p>
                        )}
                        {alternative.href === null ? null : (
                            <p className="text-xs text-text-muted">{m.onboarding_alternative_come_back()}</p>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** Lines a multi-line answer starts with, before it grows with the text. */
const MULTILINE_ROWS = 3;

/**
 * A text answer in the app's own field. A multi-line answer grows with its text; Enter adds a line there and
 * ⌘/Ctrl+Enter continues, since setup answers are often pasted notes.
 */
function AnswerBox({
    id,
    describedBy,
    multiline,
    value,
    placeholder,
    required,
    code = false,
    onChange,
}: {
    readonly id: string;
    readonly describedBy: string | undefined;
    readonly multiline: boolean;
    readonly value: string;
    readonly placeholder: string | undefined;
    readonly required: boolean;
    /** A code to paste: monospace, and no autocomplete or spell check that would change it. */
    readonly code?: boolean;
    readonly onChange: (value: string) => void;
}) {
    const box = useRef<HTMLTextAreaElement>(null);
    // `field-sizing: content` would do this in CSS, but not in every browser the engine supports. The height goes
    // through the CSSOM, which the CSP allows.
    useLayoutEffect(() => {
        const element = box.current;
        if (element === null) return;
        element.style.height = '';
        if (element.scrollHeight > element.clientHeight) element.style.height = `${String(element.scrollHeight)}px`;
    }, [value]);
    const control = {
        id,
        value,
        placeholder,
        required,
        'aria-describedby': describedBy,
        ...(code ? { autoComplete: 'off', spellCheck: false } : {}),
        className: cx(code && 'font-mono'),
    };
    return multiline ? (
        <Textarea
            {...control}
            ref={box}
            rows={MULTILINE_ROWS}
            className={cx(control.className, 'max-h-[40dvh] resize-none overflow-y-auto')}
            onChange={(event) => {
                onChange(event.target.value);
            }}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                }
            }}
        />
    ) : (
        <Input
            {...control}
            onChange={(event) => {
                onChange(event.target.value);
            }}
        />
    );
}

function TextPrompt({
    prompt,
    busy,
    onAnswer,
    onBack,
    onAlternative,
}: PromptFormProps<Extract<OnboardingPrompt, { kind: 'text' }>>) {
    const [text, setText] = useState(prompt.initial);
    const [files, setFiles] = useState<readonly UploadedFile[]>([]);
    const [uploading, setUploading] = useState(false);
    const id = useId();
    const hintId = useId();
    const blank = text.trim() === '';
    return (
        <Frame
            prompt={prompt}
            busy={busy}
            onBack={onBack}
            onAlternative={onAlternative}
            submit={{ disabled: uploading || (prompt.required && blank) }}
            onSubmit={() => {
                onAnswer({ kind: 'text', text, fileIds: files.map(({ id: fileId }) => fileId) });
            }}
        >
            <div className="flex flex-col gap-2">
                {/* The engine's question, the label of the answer below it. */}
                <label htmlFor={id} className="text-base [overflow-wrap:anywhere]">
                    {prompt.question}
                </label>
                <PromptDetails details={prompt.details} />
                <AnswerBox
                    id={id}
                    describedBy={prompt.hint === null ? undefined : hintId}
                    multiline={prompt.multiline}
                    value={text}
                    placeholder={prompt.placeholder ?? undefined}
                    required={prompt.required}
                    onChange={setText}
                />
                {prompt.hint === null ? null : (
                    <p id={hintId} className="text-sm text-text-muted">
                        {prompt.hint}
                    </p>
                )}
            </div>
            {prompt.attachments ? (
                <OnboardingUpload maxFiles={20} files={files} onChange={setFiles} onBusyChange={setUploading} />
            ) : null}
        </Frame>
    );
}

function ChoicePrompt({
    prompt,
    busy,
    onAnswer,
    onBack,
    onAlternative,
}: PromptFormProps<Extract<OnboardingPrompt, { kind: 'choice' }>>) {
    const [selected, setSelected] = useState<readonly string[]>(prompt.initial);
    const name = useId();
    const toggle = (id: string, checked: boolean) => {
        if (!prompt.multiple) setSelected([id]);
        else setSelected(checked ? [...selected, id] : selected.filter((other) => other !== id));
    };
    return (
        <Frame
            prompt={prompt}
            busy={busy}
            onBack={onBack}
            onAlternative={onAlternative}
            submit={{ disabled: selected.length === 0 }}
            onSubmit={() => {
                onAnswer({ kind: 'choice', choiceIds: [...selected] });
            }}
        >
            <fieldset className="flex flex-col gap-2.5">
                <legend className="mb-1.5 text-base [overflow-wrap:anywhere]">{prompt.question}</legend>
                {prompt.hint === null ? null : <p className="mb-1.5 text-sm text-text-muted">{prompt.hint}</p>}
                <PromptDetails details={prompt.details} />
                {prompt.choices.map((choice) => (
                    <label
                        key={choice.id}
                        className={cx(
                            'flex cursor-pointer items-start gap-3 rounded-surface border border-divider px-4 py-3.5',
                            'hover:bg-hover has-checked:border-border has-checked:bg-selected',
                            'has-focus-visible:outline-2 has-focus-visible:outline-focus',
                            'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                            'has-disabled:cursor-not-allowed has-disabled:opacity-60',
                        )}
                    >
                        <input
                            type={prompt.multiple ? 'checkbox' : 'radio'}
                            name={name}
                            className="mt-0.5 size-4 shrink-0 accent-(--color-primary)"
                            checked={selected.includes(choice.id)}
                            disabled={choice.disabled}
                            onChange={(event) => {
                                toggle(choice.id, event.target.checked);
                            }}
                        />
                        <span className="flex min-w-0 flex-col">
                            <span className="text-sm font-medium break-words">{choice.label}</span>
                            {choice.description === null ? null : (
                                <span className="text-xs break-words text-text-muted">{choice.description}</span>
                            )}
                        </span>
                    </label>
                ))}
            </fieldset>
        </Frame>
    );
}

function UploadPrompt({
    prompt,
    busy,
    onAnswer,
    onBack,
    onAlternative,
}: PromptFormProps<Extract<OnboardingPrompt, { kind: 'upload' }>>) {
    const [files, setFiles] = useState<readonly UploadedFile[]>([]);
    const [uploading, setUploading] = useState(false);
    return (
        <Frame
            prompt={prompt}
            busy={busy}
            onBack={onBack}
            onAlternative={onAlternative}
            submit={{ disabled: uploading || (prompt.required && files.length === 0) }}
            onSubmit={() => {
                onAnswer({ kind: 'upload', fileIds: files.map(({ id }) => id) });
            }}
        >
            <Question prompt={prompt} />
            <OnboardingUpload
                maxFiles={prompt.maxFiles}
                files={files}
                onChange={setFiles}
                onBusyChange={setUploading}
            />
        </Frame>
    );
}

/**
 * A secret only the engine keeps, e.g. a provider API key. The value lives in the DOM input alone: no React state, no
 * draft, no query. Submitting empties the field before the request goes out, so a refused key is typed again into an
 * empty field, and leaving the step empties it too.
 */
function SecretPromptForm({ prompt, busy, onAnswer, onBack, onAlternative }: PromptFormProps<SecretPrompt>) {
    const input = useRef<HTMLInputElement>(null);
    const [blank, setBlank] = useState(true);
    const id = useId();
    const hintId = useId();
    useEffect(() => {
        const element = input.current;
        return () => {
            if (element !== null) element.value = '';
        };
    }, []);
    return (
        <Frame
            prompt={prompt}
            busy={busy}
            onBack={onBack}
            onAlternative={onAlternative}
            submit={{ disabled: blank }}
            onSubmit={() => {
                const element = input.current;
                if (element === null) return;
                const typed = element.value.trim();
                element.value = '';
                setBlank(true);
                if (typed !== '') onAnswer({ kind: 'secret', value: new OneTimeValue(typed) });
            }}
        >
            <div className="flex flex-col gap-1.5">
                <p className="text-base [overflow-wrap:anywhere]">{prompt.question}</p>
                <PromptDetails details={prompt.details} />
            </div>
            <div className="flex flex-col gap-2">
                <label htmlFor={id} className="text-sm font-medium [overflow-wrap:anywhere]">
                    {prompt.label}
                </label>
                <Input
                    ref={input}
                    id={id}
                    type="password"
                    // `off` rather than `new-password`: this is a key to paste, not a password to generate or save.
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-1p-ignore=""
                    data-lpignore="true"
                    required
                    maxLength={MAX_ONBOARDING_SECRET_LENGTH}
                    placeholder={prompt.placeholder ?? undefined}
                    aria-describedby={prompt.hint === null ? undefined : hintId}
                    aria-invalid={prompt.error === null ? undefined : true}
                    className="font-mono"
                    onChange={(event) => {
                        setBlank(event.target.value.trim() === '');
                    }}
                />
                {prompt.hint === null ? null : (
                    <p id={hintId} className="text-sm text-text-muted">
                        {prompt.hint}
                    </p>
                )}
                <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-text-muted">
                    <span>{m.onboarding_secret_trust()}</span>
                    {prompt.helpUrl === null ? null : (
                        <ExternalLink href={prompt.helpUrl}>{m.onboarding_secret_help()}</ExternalLink>
                    )}
                </p>
            </div>
        </Frame>
    );
}

/**
 * The harness's own sign-in, exactly as the engine reports it: a link to the provider, the code to type there or a
 * field for the code the provider hands back. The code goes only to the engine, never into a chat.
 */
function HarnessLogin({ prompt, busy, onAnswer, onBack, onAlternative }: PromptFormProps<HarnessLoginPrompt>) {
    const [returnCode, setReturnCode] = useState('');
    const returnCodeId = useId();
    const pending = prompt.status === 'waiting' || prompt.status === 'verifying';
    const failed = !pending && prompt.status !== 'succeeded';
    const pasting = prompt.method === 'return-code' && prompt.status === 'waiting';
    return (
        <Frame
            prompt={prompt}
            busy={busy}
            onBack={onBack}
            onAlternative={onAlternative}
            {...(pasting
                ? {
                      submit: { disabled: returnCode.trim() === '' },
                      onSubmit: () => {
                          onAnswer({ kind: 'harness-login', returnCode: returnCode.trim() });
                      },
                  }
                : {})}
        >
            <div className="flex flex-col gap-1.5">
                <p className="text-base [overflow-wrap:anywhere]">{prompt.question}</p>
                <PromptDetails details={prompt.details} />
            </div>
            <ol className="flex list-decimal flex-col gap-4 ps-5 text-sm marker:text-text-muted marker:tabular-nums">
                <li>
                    <ExternalLink href={prompt.url}>
                        {m.onboarding_login_open({ harness: prompt.harness })}
                    </ExternalLink>
                </li>
                {prompt.userCode === null ? null : (
                    <li>
                        {/* A flex list item would lose its number, so the layout lives one level down. */}
                        <div className="flex flex-col gap-1">
                            <span>{m.onboarding_login_enter_code()}</span>
                            <code className="w-fit rounded-control bg-neutral-soft px-3 py-2 font-mono text-xl tracking-widest select-all">
                                {prompt.userCode}
                            </code>
                        </div>
                    </li>
                )}
                {pasting ? (
                    <li>
                        <div className="flex flex-col gap-2">
                            <label htmlFor={returnCodeId}>
                                {m.onboarding_login_return_code({ harness: prompt.harness })}
                            </label>
                            <AnswerBox
                                id={returnCodeId}
                                describedBy={undefined}
                                multiline={false}
                                value={returnCode}
                                placeholder={undefined}
                                required
                                code
                                onChange={setReturnCode}
                            />
                        </div>
                    </li>
                ) : null}
            </ol>
            {prompt.hint === null ? null : <p className="text-sm text-text-muted">{prompt.hint}</p>}
            {pending && prompt.method === 'device-code' ? (
                <p className="flex items-center gap-2 text-sm text-text-muted" role="status">
                    <Spinner size="sm" announce={false} />
                    {prompt.status === 'verifying' ? m.onboarding_login_verifying() : m.onboarding_login_waiting()}
                </p>
            ) : null}
            {failed ? (
                <Banner
                    tone="danger"
                    title={m.onboarding_login_failed()}
                    action={
                        <Button
                            size="sm"
                            loading={busy}
                            onClick={() => {
                                onAnswer({ kind: 'harness-login', returnCode: null });
                            }}
                        >
                            {m.onboarding_login_retry()}
                        </Button>
                    }
                >
                    {prompt.diagnostic ?? m.onboarding_login_failed_body()}
                </Banner>
            ) : null}
            <p className="text-xs text-text-muted">{m.onboarding_login_trust()}</p>
        </Frame>
    );
}

/**
 * A step of a kind this UI does not know yet: the engine's heading and question survive, and the step is answered on
 * the engine's computer meanwhile. The page keeps polling, so it moves on once that is done.
 */
function UnsupportedPrompt({ prompt }: { readonly prompt: UnsupportedOnboardingPrompt }) {
    const engine = useSuspenseQuery(engineInfoQueryOptions(useEngineApi())).data;
    const command = engine.engineId === null ? 'ptbk onboarding' : `ptbk onboarding --id ${engine.engineId}`;
    return (
        <div className="flex flex-col gap-4">
            <p className="text-base [overflow-wrap:anywhere]">{prompt.question}</p>
            <div className="flex flex-col gap-2 rounded-surface border border-hairline px-4 py-3">
                <p className="text-sm font-medium">{m.onboarding_unsupported_title()}</p>
                <p className="text-sm text-text-muted">{m.onboarding_unsupported_body()}</p>
                <div className="flex items-center gap-2">
                    <code className="rounded-control bg-neutral-soft px-2.5 py-1.5 font-mono text-sm">{command}</code>
                    <CopyButton value={command} size="sm" variant="ghost" />
                </div>
                <p className="flex items-center gap-2 text-xs text-text-muted" role="status">
                    <Spinner size="sm" announce={false} />
                    {m.onboarding_unsupported_waiting()}
                </p>
            </div>
        </div>
    );
}
