import { cx } from '../../internal/cx';
import { CopyButton } from '../copy-button/copy-button';

export interface CodeTextProps {
    /** Shown verbatim (only grouped visually) and copied unformatted. */
    readonly value: string;
    /** Splits the value into groups of this many characters for readability, e.g. 4 for fingerprints and hashes. */
    readonly group?: number;
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

/**
 * Identifiers, hashes and fingerprints in monospace. Groups are separated by margin, not by characters, so the
 * text content, a selection and the copied value all stay the exact value.
 */
export function CodeText({ value, group, copyable = false, copyLabel, className }: CodeTextProps) {
    return (
        <span className={cx('inline-flex max-w-full items-center gap-1', className)}>
            <code className="min-w-0 rounded-small bg-(--code-text-bg) px-1.5 py-0.5 font-mono text-sm break-all text-(--code-text-text)">
                {groups(value, group).map((part, index) => (
                    // Groups can repeat (e.g. "AAAA"), so the position is the identity.
                    <span key={index} className={index === 0 ? undefined : 'ms-1'}>
                        {part}
                    </span>
                ))}
            </code>
            {copyable ? <CopyButton value={value} {...(copyLabel === undefined ? {} : { label: copyLabel })} /> : null}
        </span>
    );
}
