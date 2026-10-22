import type { AgentId, Revision, RevisionSummary } from '@ptbk/engine-api';
import { Banner, Button, Dialog, ErrorState, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { revisionQueryOptions } from './book-queries';
import { BookViewer } from './editor/book-viewer';

export interface RevisionDialogProps {
    readonly agentId: AgentId;
    readonly revision: RevisionSummary;
    /** The saved current version's text, to compare against. */
    readonly currentSource: string;
    readonly isCurrent: boolean;
    readonly canRestore: boolean;
    /** The editor holds changes a restore would replace. */
    readonly hasUnsavedChanges: boolean;
    readonly restoring: boolean;
    readonly onRestore: (revision: Revision) => void;
    readonly onClose: () => void;
}

/** One version of the book, read-only, optionally as its changes against the current version, with restore. */
export function RevisionDialog({
    agentId,
    revision: summary,
    currentSource,
    isCurrent,
    canRestore,
    hasUnsavedChanges,
    restoring,
    onRestore,
    onClose,
}: RevisionDialogProps) {
    const revision = useQuery(revisionQueryOptions(useEngineApi(), agentId, summary.id));
    const [compare, setCompare] = useState(false);
    const savedAt = new Date(summary.createdAt).toLocaleString();

    let body;
    if (revision.isPending) {
        body = (
            <div aria-busy="true">
                <span className="sr-only" role="status">
                    {m.loading()}
                </span>
                <Skeleton shape="block" className="h-96 w-full" />
            </div>
        );
    } else if (revision.isError) {
        body = (
            <ErrorState
                message={m.book_revision_error()}
                onRetry={() => void revision.refetch()}
                retrying={revision.isFetching}
            />
        );
    } else {
        body = (
            <div className="flex min-w-0 flex-col gap-3">
                {canRestore && !isCurrent && hasUnsavedChanges ? (
                    <Banner tone="warning">{m.book_revision_restore_discards()}</Banner>
                ) : null}
                {isCurrent ? null : (
                    <Button
                        variant="secondary"
                        size="sm"
                        className="self-start"
                        aria-pressed={compare}
                        onClick={() => {
                            setCompare((value) => !value);
                        }}
                    >
                        {m.book_revision_compare()}
                    </Button>
                )}
                {compare ? <p className="text-sm text-text-muted">{m.book_revision_compare_hint()}</p> : null}
                <BookViewer
                    source={revision.data.source}
                    {...(compare ? { compareWith: currentSource } : {})}
                    label={compare ? m.book_revision_diff_label() : m.book_revision_label()}
                />
            </div>
        );
    }

    return (
        <Dialog
            open
            onClose={onClose}
            size="lg"
            title={m.book_revision_title({ savedAt })}
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        {m.ui_close()}
                    </Button>
                    {canRestore && !isCurrent && revision.data !== undefined ? (
                        <Button
                            variant="primary"
                            loading={restoring}
                            onClick={() => {
                                onRestore(revision.data);
                            }}
                        >
                            {m.book_revision_restore()}
                        </Button>
                    ) : null}
                </>
            }
        >
            {body}
        </Dialog>
    );
}
