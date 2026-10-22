import type { Diagnostic } from '@ptbk/engine-api';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { useId } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';

export interface ProblemsListProps {
    readonly diagnostics: readonly Diagnostic[];
    readonly checking: boolean;
    readonly failed: boolean;
    readonly onSelect: (diagnostic: Diagnostic) => void;
    /** 3 where the list sits under a section heading of its own (a wizard step). */
    readonly headingLevel?: 2 | 3;
}

const ICONS = { error: CircleAlert, warning: TriangleAlert, info: Info } as const;
const TONES = { error: 'text-danger', warning: 'text-warning', info: 'text-info' } as const;

function severityLabel(severity: Diagnostic['severity']): string {
    switch (severity) {
        case 'error':
            return m.book_problem_error();
        case 'warning':
            return m.book_problem_warning();
        case 'info':
            return m.book_problem_info();
    }
}

function summary({ diagnostics, checking, failed }: ProblemsListProps): string {
    if (checking) return m.book_problems_checking();
    if (failed) return m.book_problems_check_failed();
    return diagnostics.length === 0 ? m.book_problems_none() : m.book_problems_count({ count: diagnostics.length });
}

/** The engine's diagnostics below the editor; choosing one selects its range in the editor. */
export function ProblemsList(props: ProblemsListProps) {
    const { diagnostics, onSelect, headingLevel = 2 } = props;
    const Heading = headingLevel === 3 ? 'h3' : 'h2';
    const headingId = useId();
    return (
        <section aria-labelledby={headingId} className="flex flex-col gap-2">
            <Heading id={headingId} className="text-base font-semibold">
                {m.book_problems_title()}
            </Heading>
            <p role="status" className="text-sm text-text-muted">
                {summary(props)}
            </p>
            {diagnostics.length === 0 ? null : (
                <ul className="flex flex-col gap-1">
                    {diagnostics.map((diagnostic, index) => {
                        const Icon = ICONS[diagnostic.severity];
                        return (
                            <li key={`${String(index)}-${diagnostic.code}`}>
                                <button
                                    type="button"
                                    className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                                    onClick={() => {
                                        onSelect(diagnostic);
                                    }}
                                >
                                    <Icon
                                        aria-hidden
                                        className={cx('mt-0.5 size-4 shrink-0', TONES[diagnostic.severity])}
                                    />
                                    <span className="sr-only">{severityLabel(diagnostic.severity)}</span>
                                    <span className="shrink-0 text-text-muted">
                                        {m.book_problem_line({ line: diagnostic.range.startLine })}
                                    </span>
                                    <span className="min-w-0 break-words">{diagnostic.message}</span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
