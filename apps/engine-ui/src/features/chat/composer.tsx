import { MAX_MESSAGE_LENGTH } from '@ptbk/engine-api';
import { Field, IconButton } from '@ptbk/ui';
import { ArrowUp, Square, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, Ref } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { tintStyle } from './references/agent-color';
import { applyMention, findMentionQuery, matchMentionCandidates } from './references/mention-query';
import type { MentionQuery } from './references/mention-query';

/** An agent the member can mention or address; `color` is a `--tint` value (see `agentColor`). */
export interface ComposerAgent {
    readonly key: string;
    readonly name: string;
    readonly color: string;
    readonly description: string | null;
}

export interface ComposerProps {
    readonly label: string;
    /** In a conversation the box explains itself; the label stays for assistive technology. */
    readonly labelHidden?: boolean;
    readonly placeholder: string;
    /** A reply is under way: the text cannot change or be sent. */
    readonly busy: boolean;
    /** The send is waiting for the member to check on it, so Send stays off without claiming to be working. */
    readonly sendPaused?: boolean;
    /** Whether Stop replaces Send: a reply is streaming (`ready`) or its cancel is on the way (`stopping`). */
    readonly stop?: 'ready' | 'stopping';
    /** Resolves `false` when the message did not go out; the text then comes back into the box. */
    readonly onSend: (content: string) => Promise<boolean>;
    readonly onStop?: () => void;
    /** What `@` offers, members of the thread first; without it `@` is just a character. */
    readonly mentionables?: readonly ComposerAgent[];
    /** The agent the message goes to: shown as "to @Name ×", and the message goes out as `+@Name …`. */
    readonly addressee?: ComposerAgent | null;
    /** Picking with `+@` sets it; × and Backspace at the start clear it (`null`), and so does a sent message. */
    readonly onAddresseeChange?: (agent: ComposerAgent | null) => void;
    readonly textareaRef?: Ref<HTMLTextAreaElement>;
    readonly className?: string;
}

/** Enough to pick from without scrolling a list over the thread. */
const MAX_SUGGESTIONS = 6;

function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
    if (typeof ref === 'function') ref(value);
    else if (ref !== undefined && ref !== null) ref.current = value;
}

function AddressChip({
    agent,
    onClear,
}: {
    readonly agent: ComposerAgent;
    readonly onClear?: (() => void) | undefined;
}) {
    return (
        <span
            className="inline-flex max-w-[45%] shrink-0 items-center gap-1 self-center rounded-pill bg-[color-mix(in_oklab,var(--tint)_12%,transparent)] py-0.5 ps-2.5 pe-1 text-sm motion-safe:animate-fade-in"
            style={tintStyle(agent.color)}
        >
            <span className="text-text-muted">{m.chat_composer_to()}</span>
            <span className="truncate font-medium text-tint">{`@${agent.name}`}</span>
            {onClear === undefined ? null : (
                <button
                    type="button"
                    aria-label={m.chat_composer_unaddress({ name: agent.name })}
                    onClick={onClear}
                    className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-text-muted hover:bg-hover hover:text-text"
                >
                    <X aria-hidden className="size-3.5" />
                </button>
            )}
        </span>
    );
}

/**
 * One rounded box that grows with its text, with Send (or Stop) inside it. Enter sends, Shift+Enter adds a line, Esc
 * stops a reply. While a reply streams the box is read-only rather than disabled, so focus stays in it and Esc still
 * reaches the panel. `@` suggests agents in a listbox the textarea drives (the ARIA combobox pattern on a textbox);
 * `+@` addresses the picked agent instead of mentioning it.
 */
export function Composer({
    label,
    labelHidden = false,
    placeholder,
    busy,
    sendPaused = false,
    stop,
    onSend,
    onStop,
    mentionables = [],
    addressee = null,
    onAddresseeChange,
    textareaRef,
    className,
}: ComposerProps) {
    const hintId = useId();
    const listId = useId();
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const [query, setQuery] = useState<MentionQuery | null>(null);
    const [active, setActive] = useState(0);
    const box = useRef<HTMLTextAreaElement | null>(null);
    const pendingCaret = useRef<number | null>(null);
    const locked = busy || sending;
    const canSend = !locked && text.trim() !== '';
    const suggestions = query === null ? [] : matchMentionCandidates(mentionables, query.text, MAX_SUGGESTIONS);
    const listOpen = suggestions.length > 0;
    const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1));
    const optionId = (index: number) => `${listId}-${String(index)}`;

    // `field-sizing: content` would do this in CSS, but not in every browser the engine supports. The height goes
    // through the CSSOM, which the engine's CSP allows; `max-h-*` caps it and the box scrolls from there.
    useLayoutEffect(() => {
        const element = box.current;
        if (element === null) return;
        element.style.height = 'auto';
        // A hidden box (the book's test chat behind the Book view on a phone) measures 0: keep its natural one row.
        element.style.height = element.scrollHeight === 0 ? '' : `${String(element.scrollHeight)}px`;
        if (pendingCaret.current !== null) {
            element.setSelectionRange(pendingCaret.current, pendingCaret.current);
            pendingCaret.current = null;
        }
    }, [text]);

    const readQuery = (element: HTMLTextAreaElement) => {
        const next =
            mentionables.length === 0 || element.selectionStart !== element.selectionEnd
                ? null
                : findMentionQuery(element.value, element.selectionStart);
        if (next?.start !== query?.start) setActive(0);
        if (next?.start !== query?.start || next?.end !== query?.end || next?.text !== query?.text) setQuery(next);
    };

    const pick = (agent: ComposerAgent) => {
        if (query === null) return;
        const applied = applyMention(text, query, agent.name);
        pendingCaret.current = applied.caret;
        setText(applied.text);
        setQuery(null);
        if (query.addressing) onAddresseeChange?.(agent);
    };

    const submit = async () => {
        if (!canSend) return;
        const typed = text;
        const content = addressee === null ? typed : `+@${addressee.name} ${typed}`;
        setSending(true);
        setText('');
        setQuery(null);
        const sent = await onSend(content);
        setSending(false);
        if (!sent) setText((current) => (current === '' ? typed : current));
        else if (addressee !== null) onAddresseeChange?.(null);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.nativeEvent.isComposing) return;
        if (listOpen) {
            const move = (by: number) => {
                event.preventDefault();
                setActive((activeIndex + by + suggestions.length) % suggestions.length);
            };
            switch (event.key) {
                case 'ArrowDown':
                    move(1);
                    return;
                case 'ArrowUp':
                    move(-1);
                    return;
                case 'Enter':
                case 'Tab': {
                    const chosen = suggestions[activeIndex];
                    if (chosen === undefined || event.shiftKey) break;
                    event.preventDefault();
                    pick(chosen);
                    return;
                }
                case 'Escape':
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery(null);
                    return;
            }
        }
        if (
            event.key === 'Backspace' &&
            addressee !== null &&
            event.currentTarget.selectionStart === 0 &&
            event.currentTarget.selectionEnd === 0
        ) {
            event.preventDefault();
            onAddresseeChange?.(null);
            return;
        }
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        void submit();
    };

    return (
        <form
            className={className}
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <Field label={label} labelHidden={labelHidden}>
                {(control) => (
                    // The box, not the bare textarea, takes the focus ring, so it reads as one control with its button.
                    <div className="relative flex items-end gap-2 rounded-[1.5rem] bg-raised p-1.5 ps-3 shadow-raised ring-1 ring-divider focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-focus">
                        {listOpen ? (
                            <ul
                                id={listId}
                                role="listbox"
                                aria-label={m.chat_composer_mentions()}
                                className="absolute inset-x-0 bottom-full z-10 mb-2 flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-surface bg-raised p-1.5 shadow-overlay ring-1 ring-divider motion-safe:animate-rise-in"
                            >
                                {suggestions.map((agent, index) => (
                                    // The textarea drives the list (aria-activedescendant); the pointer may pick too.
                                    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                                    <li
                                        key={agent.key}
                                        id={optionId(index)}
                                        role="option"
                                        aria-selected={index === activeIndex}
                                        style={tintStyle(agent.color)}
                                        // Keeps focus (and the caret) in the textarea while the pointer picks.
                                        onMouseDown={(event) => {
                                            event.preventDefault();
                                        }}
                                        onClick={() => {
                                            pick(agent);
                                        }}
                                        onMouseEnter={() => {
                                            setActive(index);
                                        }}
                                        className={cx(
                                            'flex cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-1.5 text-sm',
                                            index === activeIndex && 'bg-hover',
                                        )}
                                    >
                                        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-tint" />
                                        <span className="shrink-0 font-medium">{agent.name}</span>
                                        {agent.description === null ? null : (
                                            <span className="min-w-0 truncate text-xs text-text-muted">
                                                {agent.description}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                        {addressee === null ? null : (
                            <AddressChip
                                agent={addressee}
                                onClear={
                                    onAddresseeChange === undefined
                                        ? undefined
                                        : () => {
                                              onAddresseeChange(null);
                                              box.current?.focus();
                                          }
                                }
                            />
                        )}
                        <textarea
                            {...control}
                            aria-describedby={hintId}
                            aria-autocomplete={mentionables.length > 0 ? 'list' : undefined}
                            aria-controls={listOpen ? listId : undefined}
                            aria-activedescendant={listOpen ? optionId(activeIndex) : undefined}
                            ref={(element) => {
                                box.current = element;
                                setRef(textareaRef, element);
                            }}
                            rows={1}
                            value={text}
                            placeholder={placeholder}
                            maxLength={MAX_MESSAGE_LENGTH}
                            readOnly={locked}
                            aria-disabled={locked || undefined}
                            className={cx(
                                'max-h-[40dvh] min-w-0 flex-1 resize-none self-center overflow-y-auto bg-transparent py-2 ps-1 text-base text-text outline-none placeholder:text-text-muted',
                                locked && 'text-text-muted',
                            )}
                            onChange={(event) => {
                                setText(event.target.value);
                                readQuery(event.target);
                            }}
                            onSelect={(event) => {
                                readQuery(event.currentTarget);
                            }}
                            onBlur={() => {
                                setQuery(null);
                            }}
                            onKeyDown={onKeyDown}
                        />
                        {stop !== undefined && onStop !== undefined ? (
                            <IconButton
                                label={m.chat_stop()}
                                icon={<Square className="size-3.5 fill-current" />}
                                variant="secondary"
                                loading={stop === 'stopping'}
                                onClick={onStop}
                                className="rounded-full!"
                            />
                        ) : (
                            <IconButton
                                type="submit"
                                label={m.chat_send()}
                                icon={<ArrowUp className="size-4" strokeWidth={2.5} />}
                                variant="primary"
                                disabled={!canSend}
                                loading={sending && !sendPaused}
                                className="rounded-full!"
                            />
                        )}
                    </div>
                )}
            </Field>
            <p id={hintId} className="sr-only">
                {m.chat_composer_hint()}
            </p>
        </form>
    );
}
