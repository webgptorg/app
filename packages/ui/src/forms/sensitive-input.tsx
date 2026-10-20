import { useCallback, useMemo, useRef } from 'react';
import type { InputHTMLAttributes } from 'react';

import { Input } from '../components/input/input';

export interface SensitiveInputHandle {
    /** Attaches the handle to its input; `SensitiveInput` does this. */
    readonly inputRef: (element: HTMLInputElement | null) => void;
    /** The current value, read straight from the DOM; call it once, in the submit handler. */
    readonly read: () => string;
    /** Empties the input; call it after success and after failure alike. */
    readonly clear: () => void;
}

/** For a `SensitiveInput`: the value lives only in the DOM input, never in React state or a form store. */
export function useSensitiveInput(): SensitiveInputHandle {
    const element = useRef<HTMLInputElement>(null);
    const inputRef = useCallback((input: HTMLInputElement | null) => {
        element.current = input;
    }, []);
    const read = useCallback(() => element.current?.value ?? '', []);
    const clear = useCallback(() => {
        if (element.current !== null) element.current.value = '';
    }, []);
    return useMemo(() => ({ inputRef, read, clear }), [inputRef, read, clear]);
}

export interface SensitiveInputProps extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'value' | 'defaultValue' | 'onChange' | 'type' | 'autoComplete' | 'spellCheck'
> {
    readonly handle: SensitiveInputHandle;
    readonly invalid?: boolean;
}

/**
 * A secret value (API key, token): uncontrolled and masked, never registered with a form store, not autocompleted,
 * spell-checked or remembered by the browser. Put it inside `Field` like any control.
 */
export function SensitiveInput({ handle, ...rest }: SensitiveInputProps) {
    const { inputRef } = handle;
    return (
        <Input
            {...rest}
            ref={inputRef}
            type="password"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
        />
    );
}
