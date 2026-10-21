import { CopyButton } from '@ptbk/ui';
import { Fragment, useEffect, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { highlightLines } from './highlight';
import type { HighlightedLine } from './tokens';

function renderLines(lines: readonly HighlightedLine[]) {
    return lines.map((line, lineIndex) => (
        // Lines and tokens never reorder, so their position is their identity.
        <Fragment key={lineIndex}>
            {lineIndex === 0 ? null : '\n'}
            {line.map((token, tokenIndex) =>
                token.className === '' ? (
                    <Fragment key={tokenIndex}>{token.text}</Fragment>
                ) : (
                    <span key={tokenIndex} className={token.className}>
                        {token.text}
                    </span>
                ),
            )}
        </Fragment>
    ));
}

/**
 * A fenced code block from an agent reply: shown as plain text at once, coloured when its grammar has loaded (same
 * text, so nothing moves), and copyable verbatim. It is only ever text; nothing offers to run it.
 */
export function CodeBlock({ code, lang }: { readonly code: string; readonly lang: string | null }) {
    const [highlighted, setHighlighted] = useState<{
        readonly code: string;
        readonly lines: readonly HighlightedLine[];
    }>();
    useEffect(() => {
        if (lang === null) return;
        let current = true;
        highlightLines(code, lang).then(
            (lines) => {
                if (current && lines !== null) setHighlighted({ code, lines });
            },
            // A grammar chunk that fails to load leaves the code plain, which is still correct.
            () => undefined,
        );
        return () => {
            current = false;
        };
    }, [code, lang]);
    const lines = highlighted?.code === code ? highlighted.lines : null;

    return (
        <div className="chat-code min-w-0 overflow-hidden rounded-surface border border-divider">
            <div className="flex items-center justify-between gap-2 border-b border-divider px-3 py-1">
                <span className="truncate font-mono text-xs text-text-muted">{lang ?? ''}</span>
                <CopyButton value={code} label={m.chat_code_copy()} />
            </div>
            {/* Scrolls on its own so a long line never widens the page; focusable so the keyboard can scroll it. */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
            <pre tabIndex={0} className="overflow-x-auto p-3 font-mono text-sm">
                <code>{lines === null ? code : renderLines(lines)}</code>
            </pre>
        </div>
    );
}
