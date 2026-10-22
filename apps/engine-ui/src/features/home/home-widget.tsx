import { Card, ErrorState } from '@ptbk/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { m } from '../../paraglide/messages';

export interface HomeWidgetProps<Data> {
    readonly title: string;
    readonly query: UseQueryResult<Data>;
    /** Shaped like the content, so nothing jumps when the data arrives. */
    readonly skeleton: ReactNode;
    readonly actions?: ReactNode;
    readonly children: (data: Data) => ReactNode;
}

/** One home widget with its own loading and error state: a failing endpoint costs its widget, never the home. */
export function HomeWidget<Data>({ title, query, skeleton, actions, children }: HomeWidgetProps<Data>) {
    let content: ReactNode;
    if (query.data !== undefined) content = children(query.data);
    else if (query.isError) {
        content = (
            <ErrorState
                message={m.home_widget_failed()}
                onRetry={() => {
                    void query.refetch();
                }}
                retrying={query.isFetching}
            />
        );
    } else content = <div aria-busy="true">{skeleton}</div>;
    return (
        <Card title={title} className="min-w-0" {...(actions === undefined ? {} : { actions })}>
            {content}
        </Card>
    );
}
