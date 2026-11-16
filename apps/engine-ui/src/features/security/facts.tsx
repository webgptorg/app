import { Skeleton } from '@ptbk/ui';
import type { ReactNode } from 'react';

export interface Fact {
    readonly label: string;
    readonly value: ReactNode;
}

/**
 * Property rows, as on a task's details: the name quiet on the left, the value beside it. Stacked on a phone, where a
 * hash or hostname needs the whole width.
 */
export function Facts({ facts }: { readonly facts: readonly (Fact | null)[] }) {
    return (
        <dl className="flex min-w-0 flex-col">
            {facts.map((fact) =>
                fact === null ? null : (
                    <div
                        key={fact.label}
                        className="grid grid-cols-1 items-baseline gap-x-6 gap-y-0.5 py-1.5 sm:grid-cols-[11rem_minmax(0,1fr)]"
                    >
                        <dt className="text-sm text-text-subtle">{fact.label}</dt>
                        <dd className="min-w-0 text-sm break-words">{fact.value}</dd>
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
