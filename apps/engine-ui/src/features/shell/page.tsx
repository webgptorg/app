import type { ReactNode } from 'react';

export interface PageProps {
    readonly title: string;
    /** A way back to the list this screen belongs to, above the title. */
    readonly back?: ReactNode;
    readonly actions?: ReactNode;
    readonly children: ReactNode;
}

/** The frame of every routed screen: one `h1` (the skip link and route announcements land on it) and the content. */
export function Page({ title, back, actions, children }: PageProps) {
    return (
        <section aria-labelledby="page-title" className="flex flex-col gap-6">
            {back === undefined ? null : <div className="-mb-4 flex">{back}</div>}
            <header className="flex flex-wrap items-center justify-between gap-3">
                <h1 id="page-title" className="text-2xl font-semibold">
                    {title}
                </h1>
                {actions}
            </header>
            {children}
        </section>
    );
}
