import { Fragment } from 'react';

import { cx } from '../../internal/cx';
import { CopyButton } from '../copy-button/copy-button';

export interface CodeTextProps {
    /** Shown verbatim (only grouped visually) and copied unformatted. */
    readonly value: string;
    /** Splits the value into groups of this many characters for readability, e.g. 4 for fingerprints and hashes. */
    readonly group?: number;
    /** `hostname`: lines break only after a dot, never inside a label that fits; `group` is ignored. */
    readonly kind?: 'hostname';
    readonly copyable?: boolean;
    /** Accessible name of the copy button. */
    readonly copyLabel?: string;
    readonly className?: string;
}

function groups(value: string, size: number | undefined): readonly string[] {
    if (size === undefined || size < 1) return [value];
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += size) parts.push(value.slice(index, index + size));
    return parts;
}

/** Each label keeps its trailing dot, so the parts join back to the exact hostname. */
function hostnameLabels(value: string): readonly string[] {
    return value.split(/(?<=\.)/u);
}

/**
 * Identifiers, hashes, fingerprints and hostnames in monospace. Groups are separated by margin, not by characters, so
 * the text content, a selection and the copied value all stay the exact value.
 */
export function CodeText({ value, group, kind, copyable = false, copyLabel, className }: CodeTextProps) {
    const hostname = kind === 'hostname';
    const parts = hostname ? hostnameLabels(value) : groups(value, group);
    return (
        <span className={cx('inline-flex max-w-full items-center gap-1', className)}>
            <code
                className={cx(
                    'min-w-0 rounded-small bg-(--code-text-bg) px-1.5 py-0.5 font-mono text-sm text-(--code-text-text)',
                    // With break opportunities between parts, `break-word` keeps a table column's narrowest width at
                    // one part; `anywhere` would let a cell shrink to a character per line.
                    parts.length > 1 ? 'break-words' : 'wrap-anywhere',
                )}
            >
                {parts.map((part, index) => (
                    // Groups can repeat (e.g. "AAAA"), so the position is the identity. A line breaks between
                    // parts (`<wbr>`), and inside one only when a single part is wider than the line.
                    <Fragment key={index}>
                        {index === 0 ? null : <wbr />}
                        <span className={index === 0 || hostname ? undefined : 'ms-1'}>{part}</span>
                    </Fragment>
                ))}
            </code>
            {copyable ? <CopyButton value={value} {...(copyLabel === undefined ? {} : { label: copyLabel })} /> : null}
        </span>
    );
}
