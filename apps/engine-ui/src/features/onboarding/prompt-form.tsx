import type { OnboardingAnswer, OnboardingPrompt, ReadOnboardingPrompt } from '@ptbk/engine-api';
import { Banner, Button, ExternalLink, IconButton, Spinner } from '@ptbk/ui';
import { ArrowUp } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, SubmitEvent } from 'react';

import { cx } from '../../app/cx';

import { m } from '../../paraglide/messages';
import { OnboardingUpload } from './onboarding-upload';
import type { UploadedFile } from './onboarding-upload';

type HarnessLoginPrompt = Extract<OnboardingPrompt, { kind: 'harness-login' }>;

interface PromptFormProps {
    readonly prompt: ReadOnboardingPrompt;
    readonly busy: boolean;
    readonly onAnswer: (answer: OnboardingAnswer) => void;
    readonly onBack: () => void;
}

/** One prompt as the engine sent it. Its texts are the engine's and render as plain text. */
export function PromptForm({ prompt, busy, onAnswer, onBack }: PromptFormProps) {
    switch (prompt.kind) {
        case 'text':
            return <TextPrompt prompt={prompt} busy={busy} onAnswer={onAnswer} onBack={onBack} />;
        case 'choice':
            return <ChoicePrompt prompt={prompt} busy={busy} onAnswer={onAnswer} onBack={onBack} />;
        case 'confirm':
            return (
                <Frame prompt={prompt} onBack={onBack} busy={busy}>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            variant="primary"
                            loading={busy}
                            onClick={() => {
                                onAnswer({ kind: 'confirm', confirmed: true });
                            }}
                        >
                            {prompt.confirmLabel}
                        </Button>
                        <Button
                            disabled={busy}
                            onClick={() => {
                                onAnswer({ kind: 'confirm', confirmed: false });
                            }}
                        >
                            {prompt.declineLabel}
                        </Button>
                    </div>
                </Frame>
            );
        case 'upload':
            return <UploadPrompt prompt={prompt} busy={busy} onAnswer={onAnswer} onBack={onBack} />;
        case 'harness-login':
            return <HarnessLogin prompt={prompt} busy={busy} onAnswer={onAnswer} onBack={onBack} />;
        // Placeholders until U-20 renders a secret and says what an unsupported step needs; the question is the engine's.
        case 'secret':
        case 'unsupported':
            return <p className="text-sm text-text-muted">{prompt.question}</p>;
    }
}

/** The question, the engine's hint and its refusal of the last answer, around the controls of one prompt. */
function Frame({
    prompt,
    busy,
    onBack,
    submit,
    onSubmit,
    children,
}: {
    readonly prompt: OnboardingPrompt;
    readonly busy: boolean;
    readonly onBack: () => void;
    /**
     * A Continue button that submits the form; prompts that answer by their own buttons leave it out, and `inline`
     * leaves it to the prompt, whose answer box carries its own.
     */
    readonly submit?: { readonly disabled: boolean; readonly inline?: boolean };
    readonly onSubmit?: () => void;
    readonly children: ReactNode;
}) {
    const handle = (event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit?.();
    };
    return (
        <form className="flex flex-col gap-4" onSubmit={handle} noValidate>
            {children}
            {prompt.error === null ? null : <Banner tone="danger">{prompt.error}</Banner>}
            <div className="flex flex-wrap items-center gap-2 empty:hidden">
                {submit === undefined || submit.inline === true ? null : (
                    <Button type="submit" variant="primary" loading={busy} disabled={submit.disabled}>
                        {m.onboarding_continue()}
                    </Button>
                )}
                {prompt.canGoBack ? (
                    <Button variant="ghost" disabled={busy} onClick={onBack}>
                        {m.onboarding_back()}
                    </Button>
                ) : null}
            </div>
        </form>
    );
}

/** Lines a multi-line answer starts with, before it grows with the text. */
const MULTILINE_ROWS = 3;

/**
 * The answer box: the same rounded composer as "Ask Chatter anything…" on Home, with Continue inside it, so answering
 * setup feels like answering Chatter. A multi-line answer grows with its text; Enter adds a line there and ⌘/Ctrl+Enter
 * continues, since setup answers are often pasted notes.
 */
function AnswerBox({
    id,
    describedBy,
    multiline,
    value,
    placeholder,
    required,
    busy,
    disabled,
    code = false,
    onChange,
}: {
    readonly id: string;
    readonly describedBy: string | undefined;
    readonly multiline: boolean;
    readonly value: string;
    readonly placeholder: string | undefined;
    readonly required: boolean;
    readonly busy: boolean;
    readonly disabled: boolean;
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
        className: cx(
            'min-w-0 flex-1 resize-none self-center bg-transparent py-2 ps-1 text-base text-text outline-none placeholder:text-text-muted',
            code && 'font-mono',
        ),
    };
    return (
        <div
            className={cx(
                'flex gap-2 rounded-[1.5rem] bg-raised p-1.5 ps-3 shadow-raised ring-1 ring-divider',
                'focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-focus',
                multiline ? 'items-end' : 'items-center',
            )}
        >
            {multiline ? (
                <textarea
                    {...control}
                    ref={box}
                    rows={MULTILINE_ROWS}
                    className={cx(control.className, 'max-h-[40dvh] overflow-y-auto')}
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
                <input
                    {...control}
                    type="text"
                    onChange={(event) => {
                        onChange(event.target.value);
                    }}
                />
            )}
            <IconButton
                type="submit"
                label={m.onboarding_continue()}
                icon={<ArrowUp className="size-4" strokeWidth={2.5} />}
                variant="primary"
                disabled={disabled}
                loading={busy}
                className="shrink-0 rounded-full!"
            />
        </div>
    );
}

function TextPrompt({
    prompt,
    busy,
    onAnswer,
    onBack,
}: PromptFormProps & { readonly prompt: Extract<OnboardingPrompt, { kind: 'text' }> }) {
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
            submit={{ disabled: uploading || (prompt.required && blank), inline: true }}
            onSubmit={() => {
                onAnswer({ kind: 'text', text, fileIds: files.map(({ id: fileId }) => fileId) });
            }}
        >
            <div className="flex flex-col gap-2">
                {/* Chatter's question, the label of the answer below it. */}
                <label htmlFor={id} className="text-base [overflow-wrap:anywhere]">
                    {prompt.question}
                </label>
                <AnswerBox
                    id={id}
                    describedBy={prompt.hint === null ? undefined : hintId}
                    multiline={prompt.multiline}
                    value={text}
                    placeholder={prompt.placeholder ?? undefined}
                    required={prompt.required}
                    busy={busy}
                    disabled={uploading || (prompt.required && blank)}
                    onChange={setText}
                />
                {prompt.hint === null ? null : (
                    <p id={hintId} className="px-3 text-xs text-text-muted">
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
}: PromptFormProps & { readonly prompt: Extract<OnboardingPrompt, { kind: 'choice' }> }) {
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
            submit={{ disabled: selected.length === 0 }}
            onSubmit={() => {
                onAnswer({ kind: 'choice', choiceIds: [...selected] });
            }}
        >
            <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-base [overflow-wrap:anywhere]">{prompt.question}</legend>
                {prompt.hint === null ? null : <p className="mb-1 text-xs text-text-muted">{prompt.hint}</p>}
                {prompt.choices.map((choice) => (
                    <label
                        key={choice.id}
                        className={cx(
                            'flex cursor-pointer items-start gap-3 rounded-surface border border-hairline px-3.5 py-3',
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
}: PromptFormProps & { readonly prompt: Extract<OnboardingPrompt, { kind: 'upload' }> }) {
    const [files, setFiles] = useState<readonly UploadedFile[]>([]);
    const [uploading, setUploading] = useState(false);
    return (
        <Frame
            prompt={prompt}
            busy={busy}
            onBack={onBack}
            submit={{ disabled: uploading || (prompt.required && files.length === 0) }}
            onSubmit={() => {
                onAnswer({ kind: 'upload', fileIds: files.map(({ id }) => id) });
            }}
        >
            <div className="flex flex-col gap-1">
                <p className="text-base [overflow-wrap:anywhere]">{prompt.question}</p>
                {prompt.hint === null ? null : <p className="text-xs text-text-muted">{prompt.hint}</p>}
            </div>
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
 * The harness's own sign-in, exactly as the engine reports it: a link to the provider, the code to type there or a
 * field for the code the provider hands back. The code goes only to the engine, never into a chat.
 */
function HarnessLogin({ prompt, busy, onAnswer, onBack }: PromptFormProps & { readonly prompt: HarnessLoginPrompt }) {
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
            {...(pasting
                ? {
                      submit: { disabled: returnCode.trim() === '', inline: true },
                      onSubmit: () => {
                          onAnswer({ kind: 'harness-login', returnCode: returnCode.trim() });
                      },
                  }
                : {})}
        >
            <p className="text-base [overflow-wrap:anywhere]">{prompt.question}</p>
            <ol className="flex list-decimal flex-col gap-3 ps-5 text-sm marker:text-text-muted marker:tabular-nums">
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
                                busy={busy}
                                disabled={returnCode.trim() === ''}
                                code
                                onChange={setReturnCode}
                            />
                        </div>
                    </li>
                ) : null}
            </ol>
            {prompt.hint === null ? null : <p className="text-xs text-text-muted">{prompt.hint}</p>}
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
