import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { AgentSource, Diagnostic, Revision, RevisionSummary } from '@ptbk/engine-api';
import { Banner, Button, Dialog, ErrorState, Skeleton, StatusDot } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { useAgentIdParam } from '../agents/agent-detail-route';
import { BookHistory } from './book-history';
import { BookViewSwitch } from './book-view-switch';
import type { BookView } from './book-view-switch';
import { agentSourceQueryOptions } from './book-queries';
import { BookEditor } from './editor/book-editor';
import type { BookEditorHandle } from './editor/book-editor';
import { BookViewer } from './editor/book-viewer';
import { ProblemsList } from './problems-list';
import { RevisionDialog } from './revision-dialog';
import { draftAgentName } from './test-chat/draft-agent-name';
import { TestChatPanel } from './test-chat/test-chat-panel';
import { useBookWorkspace } from './use-book-workspace';

/** Shaped like the editor and its toolbar, so the content replaces it without shifting the layout. */
export function BookEditorSkeleton() {
    return (
        <div aria-busy="true" className="flex min-h-0 flex-1 flex-col gap-3">
            <span className="sr-only" role="status">
                {m.loading()}
            </span>
            <div className="flex items-center justify-end gap-3">
                <Skeleton shape="text" className="h-5 w-32" />
                <Skeleton shape="block" className="h-9 w-24" />
            </div>
            <Skeleton shape="block" className="min-h-48 w-full flex-1" />
        </div>
    );
}

function BookWorkspace({ initial }: { initial: AgentSource }) {
    const agentId = initial.agentId;
    const {
        base,
        draft,
        change,
        dirty,
        conflict,
        canWrite,
        hasEditor,
        validation,
        save,
        saveDraft,
        restore,
        restoreSource,
        reload,
    } = useBookWorkspace(initial);
    const editor = useRef<BookEditorHandle>(null);
    const [showConflictDiff, setShowConflictDiff] = useState(false);
    const [openRevision, setOpenRevision] = useState<RevisionSummary | null>(null);
    const testable = useAllows({ capability: KNOWN_CAPABILITIES.testChat, permission: 'agents.write' });
    const [view, setView] = useState<BookView>('book');

    const restoreRevision = async (revision: Revision) => {
        const updated = await restoreSource(revision);
        if (updated) editor.current?.reset(updated.source);
        setOpenRevision(null);
    };

    const showInvalidBook = useCallback(
        (diagnostics: readonly Diagnostic[]) => {
            validation.show(diagnostics);
        },
        [validation],
    );

    const showProblems = () => {
        setView('book');
        const first = validation.diagnostics.find(({ severity }) => severity === 'error') ?? validation.diagnostics[0];
        // The editor is displayed again only after this render.
        requestAnimationFrame(() => {
            if (first) editor.current?.focusRange(first.range);
        });
    };

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            <div className="flex min-h-8 flex-wrap items-center gap-3">
                {testable ? <BookViewSwitch view={view} onChange={setView} className="xl:hidden" /> : null}
                <div className="ms-auto flex flex-wrap items-center justify-end gap-3">
                    {/* On a phone the Save button's state says it, and the switch needs the row. */}
                    <p className="flex items-center gap-1.5 text-xs text-text-muted max-sm:sr-only" role="status">
                        {canWrite && dirty ? <StatusDot tone="warning" /> : null}
                        {canWrite ? (dirty ? m.book_unsaved() : m.book_all_saved()) : m.book_read_only()}
                    </p>
                    {canWrite ? (
                        <Button
                            variant="primary"
                            size="sm"
                            loading={save.isPending}
                            disabled={!dirty}
                            aria-keyshortcuts="Control+S Meta+S"
                            onClick={() => void saveDraft()}
                        >
                            <Save aria-hidden className="size-4" />
                            {m.book_save()}
                        </Button>
                    ) : null}
                </div>
            </div>
            {conflict === null ? null : (
                <Banner
                    tone="warning"
                    title={m.book_conflict_title()}
                    action={
                        <div className="flex flex-wrap gap-2">
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                    setShowConflictDiff(true);
                                }}
                            >
                                {m.book_conflict_diff()}
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                    editor.current?.reset(conflict.source);
                                    reload();
                                    setShowConflictDiff(false);
                                }}
                            >
                                {m.book_conflict_reload()}
                            </Button>
                        </div>
                    }
                >
                    {m.book_conflict_body()}
                </Banner>
            )}
            {/* The editor and the test chat share the screen's height, so the test composer is always in view. */}
            <div
                className={cx(
                    'grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)] gap-6',
                    testable && 'xl:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] xl:gap-0',
                )}
            >
                {/* Hidden rather than unmounted, so switching views keeps the editor's state and the conversation. */}
                <div
                    className={cx(
                        'flex min-h-0 min-w-0 flex-col gap-4',
                        testable && 'xl:pe-6',
                        testable && view === 'test' && 'max-xl:hidden',
                    )}
                >
                    <BookEditor
                        ref={editor}
                        fill
                        initialSource={draft}
                        onChange={change}
                        diagnostics={validation.diagnostics}
                        label={m.book_editor_label()}
                        readOnly={!canWrite}
                        onSave={() => void saveDraft()}
                    />
                    <div className="flex max-h-[40%] min-h-0 shrink-0 flex-col gap-5 overflow-y-auto">
                        {canWrite ? (
                            <ProblemsList
                                diagnostics={validation.diagnostics}
                                checking={validation.checking}
                                failed={validation.failed}
                                onSelect={(diagnostic) => editor.current?.focusRange(diagnostic.range)}
                            />
                        ) : null}
                        {hasEditor && (
                            <BookHistory
                                agentId={agentId}
                                currentRevisionId={base.revisionId}
                                onOpen={setOpenRevision}
                            />
                        )}
                    </div>
                </div>
                {testable ? (
                    <TestChatPanel
                        agentId={agentId}
                        book={draft}
                        agentName={draftAgentName(draft) ?? m.book_test_unnamed()}
                        onInvalidBook={showInvalidBook}
                        onShowProblems={showProblems}
                        headingLevel={2}
                        // On wide screens a hairline, not a card, sets the conversation beside the book.
                        className={cx('xl:border-s xl:border-hairline xl:ps-6', view === 'book' && 'max-xl:hidden')}
                    />
                ) : null}
            </div>
            {openRevision === null ? null : (
                <RevisionDialog
                    agentId={agentId}
                    revision={openRevision}
                    currentSource={base.source}
                    isCurrent={openRevision.id === base.revisionId}
                    canRestore={canWrite}
                    hasUnsavedChanges={dirty}
                    restoring={restore.isPending}
                    onRestore={(revision) => void restoreRevision(revision)}
                    onClose={() => {
                        setOpenRevision(null);
                    }}
                />
            )}
            {conflict !== null && showConflictDiff ? (
                <Dialog
                    open
                    size="lg"
                    title={m.book_conflict_diff_title()}
                    description={m.book_conflict_diff_body()}
                    onClose={() => {
                        setShowConflictDiff(false);
                    }}
                >
                    <BookViewer source={draft} compareWith={conflict.source} label={m.book_conflict_diff_title()} />
                </Dialog>
            ) : null}
        </div>
    );
}

/** The Book tab: the agent's book in the editor, its problems and its history, sized to the screen (`fillViewport`). */
export function BookEditorPage() {
    const agentId = useAgentIdParam();
    const source = useQuery(agentSourceQueryOptions(useEngineApi(), agentId));
    if (source.isPending) return <BookEditorSkeleton />;
    if (source.isError) {
        return (
            <ErrorState
                message={m.book_load_error()}
                onRetry={() => void source.refetch()}
                retrying={source.isFetching}
            />
        );
    }
    return <BookWorkspace key={agentId} initial={source.data} />;
}
