import type { z } from 'zod';

type Path = readonly PropertyKey[];

function removeKeys(value: unknown, path: Path, keys: readonly string[]): unknown {
    if (typeof value !== 'object' || value === null) {
        return value;
    }
    const [head, ...rest] = path;
    if (Array.isArray(value)) {
        return value.map((item: unknown, index) => (index === head ? removeKeys(item, rest, keys) : item));
    }
    const entries = Object.entries(value).flatMap(([name, child]): [string, unknown][] => {
        if (head === undefined) {
            return keys.includes(name) ? [] : [[name, child]];
        }
        return [[name, name === head ? removeKeys(child, rest, keys) : child]];
    });
    return Object.fromEntries(entries);
}

const MAX_PASSES = 32;

/**
 * Parses a server response tolerantly (AGENTS.md rule 5): fields the contract does not know are dropped at any depth,
 * while every known field is still fully validated. Contracts stay strict, so server tests catch undeclared fields.
 */
export function parseTolerantly<S extends z.ZodType>(
    schema: S,
    value: unknown,
): { readonly success: true; readonly data: z.output<S> } | { readonly success: false } {
    let current = value;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const result = schema.safeParse(current);
        if (result.success) {
            return { success: true, data: result.data };
        }
        const issues = result.error.issues;
        if (!issues.every((issue) => issue.code === 'unrecognized_keys')) {
            return { success: false };
        }
        for (const issue of issues) {
            current = removeKeys(current, issue.path, issue.keys);
        }
    }
    return { success: false };
}
