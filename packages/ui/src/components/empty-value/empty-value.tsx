export interface EmptyValueProps {
    /** What screen readers hear instead of the dash, e.g. "Not reported", "Never" or "None". */
    readonly label: string;
}

/**
 * The one way to show a value that is missing: a quiet dash, never a word like "Unknown" that reads as an error when
 * it repeats down a column. Screen readers hear `label`, which says why it is empty.
 */
export function EmptyValue({ label }: EmptyValueProps) {
    return (
        <span className="text-(--empty-value-text)">
            <span aria-hidden="true">—</span>
            <span className="sr-only">{label}</span>
        </span>
    );
}
