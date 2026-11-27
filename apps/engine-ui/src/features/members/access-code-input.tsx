import { ACCESS_CODE_PATTERN } from '@ptbk/engine-api';
import type { FieldControlProps } from '@ptbk/ui';
import { useState } from 'react';
import type { Ref } from 'react';

import { cx } from '../../app/cx';

export const ACCESS_CODE_LENGTH = 6;
const CELLS = Array.from({ length: ACCESS_CODE_LENGTH }, (_, index) => index);

export interface AccessCodeInputProps extends FieldControlProps {
    readonly value: string;
    readonly onChange: (value: string) => void;
    /** Called once the sixth digit is in, typed or pasted. */
    readonly onComplete: (code: string) => void;
    readonly ref?: Ref<HTMLInputElement>;
}

/** Whatever was typed or pasted ("482 913", "482-913"), as at most six digits. */
export function normaliseAccessCode(raw: string): string {
    return raw.replace(/\D/g, '').slice(0, ACCESS_CODE_LENGTH);
}

/**
 * Six cells over one real input: screen readers, paste, autofill and editing keys see an ordinary text field, while
 * the cells show the digits the way the person reads them out ("482 913"). The highlighted cell is where the next
 * digit goes, so moving to the next cell needs no focus juggling.
 */
export function AccessCodeInput({ value, onChange, onComplete, ref, ...control }: AccessCodeInputProps) {
    const [focused, setFocused] = useState(false);
    const invalid = control['aria-invalid'] === true;
    return (
        <div className="relative inline-flex items-center gap-2" data-access-code>
            {CELLS.map((index) => {
                const active = focused && index === Math.min(value.length, ACCESS_CODE_LENGTH - 1);
                return (
                    <span
                        key={index}
                        aria-hidden="true"
                        className={cx(
                            'flex h-16 w-12 items-center justify-center rounded-(--input-radius) border bg-(--input-bg) font-mono text-3xl font-semibold text-(--input-text) tabular-nums shadow-(--input-shadow)',
                            'motion-safe:transition-[border-color,box-shadow] motion-safe:duration-(--motion-state)',
                            index === ACCESS_CODE_LENGTH / 2 ? 'ms-3' : undefined,
                            invalid ? 'border-(--input-border-invalid)' : 'border-(--input-border)',
                            active ? 'border-(--input-border-focus) shadow-[0_0_0_3px_var(--input-ring)]' : undefined,
                        )}
                    >
                        {value[index] ?? ''}
                    </span>
                );
            })}
            <input
                {...control}
                ref={ref}
                value={value}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={ACCESS_CODE_LENGTH + 8}
                // The real input covers the cells and stays focusable and clickable; only its own glyphs are hidden.
                className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent"
                onFocus={() => {
                    setFocused(true);
                }}
                onBlur={() => {
                    setFocused(false);
                }}
                onChange={(event) => {
                    const next = normaliseAccessCode(event.target.value);
                    onChange(next);
                    if (next.length === ACCESS_CODE_LENGTH && next !== value && ACCESS_CODE_PATTERN.test(next))
                        onComplete(next);
                }}
            />
        </div>
    );
}
