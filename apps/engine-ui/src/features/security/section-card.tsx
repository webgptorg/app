import { Card, ErrorState } from '@ptbk/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { m } from '../../paraglide/messages';

export interface SectionCardProps<Data> {
    readonly title: string;
    readonly query: UseQueryResult<Data>;
    /** Shaped like the section's content, so nothing jumps when the data arrives. */
    readonly skeleton: ReactNode;
    readonly className?: string;
    readonly children: (data: Data) => ReactNode;
}

/**
 * One section of a panel with its own loading and error state, so a failing endpoint shows a retry in its own sections
 * while the others keep rendering.
 */
export function SectionCard<Data>({ title, query, skeleton, className, children }: SectionCardProps<Data>) {
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
    return (
        <Card title={title} {...(className === undefined ? {} : { className })}>
            {content}
        </Card>
    );
}
