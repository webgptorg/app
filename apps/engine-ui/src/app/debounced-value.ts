import { useEffect, useState } from 'react';

/** `value` once it has stopped changing for `ms`; the first value at once. */
export function useDebouncedValue<Value>(value: Value, ms: number): Value {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const handle = setTimeout(() => {
            setSettled(value);
        }, ms);
        return () => {
            clearTimeout(handle);
        };
    }, [value, ms]);
    return settled;
}
