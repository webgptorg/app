import { ErrorState, Section } from '@ptbk/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { m } from '../../paraglide/messages';

export interface QuerySectionProps<Data> {
    readonly title: string;
    readonly query: UseQueryResult<Data>;
    /** Shaped like the section's content, so nothing jumps when the data arrives. */
    readonly skeleton: ReactNode;
    /** A number beside the title once the data is in, e.g. how many passkeys are listed. */
    readonly count?: (data: Data) => number | undefined;
    readonly description?: ReactNode;
    readonly className?: string;
    readonly children: (data: Data) => ReactNode;
}

/**
 * One section of a page with its own loading and error state, so a failing endpoint shows a retry in its own section
 * while the others keep rendering. An open `Section`, a heading over content, not a bordered card.
 */
export function QuerySection<Data>({
    title,
    query,
    skeleton,
    count,
    description,
    className,
    children,
}: QuerySectionProps<Data>) {
    let content: ReactNode;
    if (query.data !== undefined) content = children(query.data);
    else if (query.isError) {
        content = (
            <ErrorState
                message={m.section_load_failed()}
                onRetry={() => {
                    void query.refetch();
                }}
                retrying={query.isFetching}
            />
        );
    } else content = <div aria-busy="true">{skeleton}</div>;
    const shownCount = query.data === undefined ? undefined : count?.(query.data);
    return (
        <Section
            title={title}
            {...(shownCount === undefined ? {} : { count: shownCount })}
            {...(description === undefined ? {} : { description })}
            {...(className === undefined ? {} : { className })}
        >
            {content}
        </Section>
    );
}
