import type { DeepKeys } from '@tanstack/react-form';

import type { ZodForm } from './use-zod-form';

/**
 * One validation error from a server, shaped like an RFC 9457 `errors` entry: `path` names the field as `name`,
 * `a.b`, `a[0].b` or a JSON Pointer (`/a/b`). Defined here, so the design system needs no contract package.
 */
export interface ServerFieldError {
    readonly path: string;
    readonly message: string;
}

/** `/a/0/b`, `a.0.b` and `a[0].b` all become TanStack Form's `a[0].b`. */
export function toFieldName(path: string): string {
    const segments = path.startsWith('/')
        ? path
              .slice(1)
              .split('/')
              .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
        : path
              .split(/\.|\[(\d+)\]/) // The capture group yields `undefined` for every `.` separator.
              .filter((segment) => Boolean(segment));
    return segments.reduce(
        (name, segment) =>
            /^\d+$/.test(segment) ? `${name}[${segment}]` : name === '' ? segment : `${name}.${segment}`,
        '',
    );
}

/**
 * Shows the server's field errors on the matching fields until the member next changes them. Returns the errors that
 * match no field on the form, for a `Banner` above it.
 */
export function applyServerErrors<Values>(
    form: ZodForm<Values>,
    errors: readonly ServerFieldError[],
): ServerFieldError[] {
    const unmatched: ServerFieldError[] = [];
    for (const error of errors) {
        const name = toFieldName(error.path) as DeepKeys<Values>;
        if (form.getFieldMeta(name) === undefined) {
            unmatched.push(error);
            continue;
        }
        form.setFieldMeta(name, (meta) => ({ ...meta, errorMap: { ...meta.errorMap, onServer: error.message } }));
    }
    return unmatched;
}
