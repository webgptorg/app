import { useEffect, useRef, useState } from 'react';

export const SEARCH_DEBOUNCE_MS = 300;

/**
 * A search box bound to the `q` search param: typing reaches `apply` (the URL, and so the engine) once it pauses, and
 * back, forward or a link that changes the URL replaces the text unless that is what is being typed.
 */
export function useDebouncedSearch(q: string | undefined, apply: (q: string | undefined) => void) {
    const [text, setText] = useState(q ?? '');
    const [urlQuery, setUrlQuery] = useState(q);
    if (q !== urlQuery) {
        setUrlQuery(q);
        if (text.trim() !== (q ?? '')) setText(q ?? '');
    }
    const applyRef = useRef(apply);
    useEffect(() => {
        applyRef.current = apply;
    });
    useEffect(() => {
        const next = text.trim() === '' ? undefined : text.trim();
        if (next === q) return;
        const handle = setTimeout(() => {
            applyRef.current(next);
        }, SEARCH_DEBOUNCE_MS);
        return () => {
            clearTimeout(handle);
        };
    }, [text, q]);
    return [text, setText] as const;
}
