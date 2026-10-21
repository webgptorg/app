import { Skeleton } from '@ptbk/ui';
import type { ReactNode } from 'react';

export interface Fact {
    readonly label: string;
    readonly value: ReactNode;
}

/** Label and value pairs as a definition list: stacked on a phone, two columns from `sm` up. */
export function Facts({ facts }: { readonly facts: readonly (Fact | null)[] }) {
    return (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
            {facts.map((fact) =>
                fact === null ? null : (
                    <div key={fact.label} className="contents">
                        <dt className="text-text-muted">{fact.label}</dt>
                        <dd className="min-w-0 break-words">{fact.value}</dd>
                    </div>
                ),
            )}
        </dl>
    );
}

/** A skeleton with the facts' rhythm, `rows` lines tall. */
export function FactsSkeleton({ rows }: { readonly rows: number }) {
    return (
        <div className="flex flex-col gap-3">
            {Array.from({ length: rows }, (_, index) => (
                <Skeleton key={index} className="h-5 w-full" />
            ))}
        </div>
    );
}
