import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { AgentId, AgentSource, Diagnostic, Revision, RevisionSummary } from '@ptbk/engine-api';
import { Banner, Button, Dialog, ErrorState, Skeleton, StatusDot } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { classifyApiError, unwrap } from '../../app/api-errors';
import type { ApiFailure } from '../../app/api-errors';
import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { useAgentIdParam } from '../agents/agent-detail-route';
import { agentKeys } from '../agents/agents-keys';
import { usePermissions } from '../session/use-permissions';
import { BookHistory } from './book-history';
import { BookViewSwitch } from './book-view-switch';
import type { BookView } from './book-view-switch';
import { bookKeys } from './book-keys';
import { agentSourceQueryOptions } from './book-queries';
import { BookEditor } from './editor/book-editor';
import type { BookEditorHandle } from './editor/book-editor';
import { BookViewer } from './editor/book-viewer';
import { ProblemsList } from './problems-list';
import { RevisionDialog } from './revision-dialog';
import { draftAgentName } from './test-chat/draft-agent-name';
import { TestChatPanel } from './test-chat/test-chat-panel';
import { UnsavedChangesGuard } from './unsaved-changes-guard';
import { useBookValidation } from './use-book-validation';

/** Saves are not cancelled by navigation, so they carry their own timeout instead of a component's signal. */
const SAVE_TIMEOUT_MS = 30_000;

function problemCode(failure: ApiFailure): string | undefined {
    return failure.kind === 'problem' ? failure.problem.code : undefined;
}

function saveFailureMessage(failure: ApiFailure): string {
    const code = problemCode(failure);
    if (code === 'revision-conflict') return m.book_save_conflict();
    if (code === 'invalid-book') return m.book_save_invalid();
    return m.book_save_failed();
}

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

interface Variables {
    readonly source: string;
    readonly baseRevisionId: AgentSource['revisionId'];
}

interface WorkspaceProps {
    readonly agentId: AgentId;
    readonly initial: AgentSource;
}

/** The editor once the source has loaded; `base` is the version the editor's text started from. */
function BookWorkspace({ agentId, initial }: WorkspaceProps) {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const { can } = usePermissions();
    const canWrite = can('agents.write');
    const editor = useRef<BookEditorHandle>(null);
    const [base, setBase] = useState(initial);
    const [draft, setDraft] = useState(initial.source);
    const [conflict, setConflict] = useState<AgentSource | null>(null);
    const [showConflictDiff, setShowConflictDiff] = useState(false);
    const [openRevision, setOpenRevision] = useState<RevisionSummary | null>(null);
    const dirty = draft !== base.source;
    const validation = useBookValidation(draft, canWrite);
    const testable = useAllows({ capability: KNOWN_CAPABILITIES.testChat, permission: 'agents.write' });
    const [view, setView] = useState<BookView>('book');

    const adopt = (saved: AgentSource) => {
        setBase(saved);
        setConflict(null);
        queryClient.setQueryData(bookKeys.source(agentId), saved);
    };

    const writeSource = (successMessage: () => string, errorMessage: (failure: ApiFailure) => string) => ({
        mutationFn: async (variables: Variables) =>
            unwrap(await engineApi.agents.updateSource(agentId, variables, AbortSignal.timeout(SAVE_TIMEOUT_MS))),
        invalidates: [bookKeys.revisions(agentId), agentKeys.detail(agentId), agentKeys.lists()],
        successMessage,
        errorMessage,
    });
    const save = useStepUpAwareMutation(writeSource(m.book_saved, saveFailureMessage));
    const restore = useStepUpAwareMutation(
        writeSource(m.book_restored, (failure) =>
            problemCode(failure) === 'revision-conflict' ? m.book_save_conflict() : m.book_restore_failed(),
        ),
    );

    const onWriteFailure = async (error: unknown) => {
        const failure = classifyApiError(error);
        if (failure.kind !== 'problem') return;
        if (failure.problem.code === 'invalid-book') validation.show(failure.problem.diagnostics ?? []);
        if (failure.problem.code === 'revision-conflict') {
            try {
                setConflict(await queryClient.query({ ...agentSourceQueryOptions(engineApi, agentId), staleTime: 0 }));
            } catch {
                // The conflict was reported in a toast; without the newer text there is nothing to compare.
            }
        }
    };

    const saveDraft = async () => {
        if (!canWrite || !dirty || save.isPending) return;
        try {
            adopt(await save.mutateAsync({ source: draft, baseRevisionId: base.revisionId }));
        } catch (error) {
            await onWriteFailure(error);
        }
    };

    const restoreRevision = async (revision: Revision) => {
        try {
            const saved = await restore.mutateAsync({ source: revision.source, baseRevisionId: base.revisionId });
            adopt(saved);
            setDraft(saved.source);
            editor.current?.reset(saved.source);
            setOpenRevision(null);
        } catch (error) {
            setOpenRevision(null);
            await onWriteFailure(error);
        }
    };

    const reload = () => {
        if (conflict === null) return;
        adopt(conflict);
        setDraft(conflict.source);
        editor.current?.reset(conflict.source);
        setShowConflictDiff(false);
    };

    const onChange = useCallback((source: string) => {
        setDraft(source);
    }, []);

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
            <UnsavedChangesGuard when={dirty} />
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
                            <Button size="sm" variant="secondary" onClick={reload}>
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
                        initialSource={initial.source}
                        onChange={onChange}
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
                        <BookHistory agentId={agentId} currentRevisionId={base.revisionId} onOpen={setOpenRevision} />
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
    return <BookWorkspace key={agentId} agentId={agentId} initial={source.data} />;
}
