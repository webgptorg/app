import { Banner } from '@ptbk/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';

export type DiffLineKind = 'added' | 'removed' | 'hunk' | 'meta' | 'context';

/** Above this many lines only the visible window is mounted. */
export const DIFF_VIRTUALIZE_ABOVE = 1_000;
const LINE_PX = 20;
const WINDOW_PX = 512;

/** What a unified diff line is, by its first characters only; the text itself is never parsed. */
export function diffLineKind(line: string): DiffLineKind {
    if (line.startsWith('@@')) return 'hunk';
    if (
        line.startsWith('+++') ||
        line.startsWith('---') ||
        line.startsWith('diff ') ||
        line.startsWith('index ') ||
        line.startsWith('\\')
    ) {
        return 'meta';
    }
    if (line.startsWith('+')) return 'added';
    if (line.startsWith('-')) return 'removed';
    return 'context';
}

const LINE_CLASSES: Readonly<Record<DiffLineKind, string>> = {
    added: 'run-diff-added',
    removed: 'run-diff-removed',
    hunk: 'run-diff-hunk',
    meta: 'run-diff-meta',
    context: '',
};

function splitLines(diff: string): readonly string[] {
    const lines = diff.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
}

function DiffLine({ line }: { readonly line: string }) {
    // The `+`, `-` and `@@` the line starts with stay visible, so the kind never rests on colour alone.
    return (
        <div className={cx('min-h-5 px-3 leading-5', LINE_CLASSES[diffLineKind(line)])}>{line === '' ? ' ' : line}</div>
    );
}

export interface DiffViewProps {
    /** Agent output: rendered as text nodes, one per line, never as HTML. */
    readonly diff: string;
    readonly truncated: boolean;
    /** Names the scrollable region, e.g. the project. */
    readonly label: string;
}

/** A unified diff, line by line with added, removed and hunk lines marked; long diffs mount only what is visible. */
export function DiffView({ diff, truncated, label }: DiffViewProps) {
    const lines = useMemo(() => splitLines(diff), [diff]);
    return (
        <div className="flex flex-col gap-2">
            {truncated ? <Banner tone="warning">{m.run_diff_truncated()}</Banner> : null}
            {lines.length > DIFF_VIRTUALIZE_ABOVE ? (
                <VirtualLines lines={lines} label={label} />
            ) : (
                <div
                    role="region"
                    aria-label={label}
                    // A scrollable region must be reachable by keyboard (axe: scrollable-region-focusable).
                    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                    tabIndex={0}
                    className="run-text max-h-128 overflow-auto rounded-surface py-2 font-mono text-xs whitespace-pre focus-visible:outline-2 focus-visible:outline-focus"
                >
                    {lines.map((line, index) => (
                        <DiffLine key={index} line={line} />
                    ))}
                </div>
            )}
        </div>
    );
}

function VirtualLines({ lines, label }: { readonly lines: readonly string[]; readonly label: string }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    // The virtualizer's own state drives this component's renders; nothing memoises what it returns.
    // eslint-disable-next-line react-hooks/incompatible-library
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: lines.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => LINE_PX,
        overscan: 20,
        initialRect: { width: 0, height: WINDOW_PX },
    });
    const items = virtualizer.getVirtualItems();
    const first = items[0];
    const last = items.at(-1);
    return (
        <div
            ref={scrollRef}
            role="region"
            aria-label={label}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            className="run-text h-128 overflow-auto rounded-surface py-2 font-mono text-xs whitespace-pre focus-visible:outline-2 focus-visible:outline-focus"
        >
            <div aria-hidden="true" style={{ height: first?.start ?? 0 }} />
            {items.map((item) => (
                <DiffLine key={item.key} line={lines[item.index] ?? ''} />
            ))}
            <div
                aria-hidden="true"
                style={{ height: last === undefined ? 0 : virtualizer.getTotalSize() - last.end }}
            />
        </div>
    );
}
