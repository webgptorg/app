import { FILE_PURPOSES } from '@ptbk/engine-api';
import type { FileMetadata } from '@ptbk/engine-api';
import { Button, Dialog, Field, Input } from '@ptbk/ui';
import type { ColumnFiltersState, MenuEntry } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { useCursorPages } from '../../app/cursor-pages';
import { useDebouncedSearch } from '../../app/debounced-search';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { isInvalidCursor } from '../../app/list-errors';
import { SoftBreaks } from '../../app/soft-breaks';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import { AgentSelect } from './agent-filter';
import { useFileDelete } from './file-delete';
import { FileDrawer } from './file-drawer';
import { filterValue, FileTable } from './file-table';
import { fileListQueryOptions, useFiles } from './files-queries';
import { fileListParams, hasFileFilters } from './files-search';
import type { FilesSearch } from './files-search';
import { KnowledgeUpload } from './knowledge-upload';

const route = getRouteApi('/files');

function filtersOf(search: FilesSearch): ColumnFiltersState {
    return [
        ...(search.purpose === undefined ? [] : [{ id: 'purpose', value: search.purpose }]),
        ...(search.scan === undefined ? [] : [{ id: 'scan', value: search.scan }]),
    ];
}

function UploadKnowledgeDialog({ onClose }: { readonly onClose: () => void }) {
    const [agentId, setAgentId] = useState<FileMetadata['agentId']>(null);
    return (
        <Dialog open onClose={onClose} title={m.files_upload_title()} size="lg">
            <div className="flex flex-col gap-4">
                <AgentSelect
                    label={m.files_upload_agent()}
                    allLabel={m.files_upload_pick_agent()}
                    value={agentId ?? undefined}
                    onChange={(chosen) => {
                        setAgentId(chosen ?? null);
                    }}
                    required
                />
                {agentId === null ? (
                    <p className="text-sm text-text-muted">{m.files_upload_pick_agent_first()}</p>
                ) : (
                    <KnowledgeUpload key={agentId} agentId={agentId} />
                )}
            </div>
        </Dialog>
    );
}

/** Every file the member can see, across agents; filters, sort and paging are the engine's, bound to the URL. */
export function FilesPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const { can } = usePermissions();
    const params = fileListParams(search);
    const list = useFiles(params);
    const deletion = useFileDelete();

    const update = (change: Partial<FilesSearch>, replace = false) => {
        void navigate({ search: (previous) => ({ ...previous, cursor: undefined, ...change }), replace });
    };
    const [text, setText] = useDebouncedSearch(search.q, (q) => {
        update({ q }, true);
    });
    const paging = useCursorPages(search.cursor, list.data?.nextCursor ?? null, (cursor) => {
        void navigate({ search: (previous) => ({ ...previous, cursor }) });
    });
    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        if (invalidCursor) void navigate({ search: (previous) => ({ ...previous, cursor: undefined }), replace: true });
    }, [invalidCursor, navigate]);

    const clear = () => {
        setText('');
        update({ q: undefined, purpose: undefined, scan: undefined, agentId: undefined });
    };
    const nameCell = useCallback(
        (file: FileMetadata) => (
            <Link
                to="/files"
                search={{ ...search, file: file.id }}
                variant="standalone"
                className="line-clamp-2 max-w-md font-medium break-words"
            >
                <SoftBreaks text={file.name} after="_" />
            </Link>
        ),
        [search],
    );
    const writable = can('files.write');
    const rowActions = (file: FileMetadata): readonly MenuEntry[] => [
        {
            kind: 'item',
            id: 'delete',
            label: m.files_delete(),
            icon: <Trash2 />,
            tone: 'danger',
            onSelect: () => {
                deletion.request(file);
            },
        },
    ];

    return (
        <Page
            title={m.files_title()}
            actions={
                writable ? (
                    <Button
                        variant="primary"
                        onClick={() => {
                            void navigate({ search: (previous) => ({ ...previous, upload: true }) });
                        }}
                    >
                        <Upload aria-hidden className="size-4" />
                        {m.files_upload_knowledge()}
                    </Button>
                ) : null
            }
        >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <Field label={m.files_search_label()} className="w-full sm:max-w-sm">
                    {(control) => (
                        <Input
                            {...control}
                            type="search"
                            value={text}
                            placeholder={m.files_search_placeholder()}
                            autoComplete="off"
                            maxLength={255}
                            onChange={(event) => {
                                setText(event.target.value);
                            }}
                        />
                    )}
                </Field>
                <AgentSelect
                    label={m.files_filter_agent()}
                    allLabel={m.files_filter_all_agents()}
                    value={search.agentId}
                    onChange={(agentId) => {
                        update({ agentId });
                    }}
                />
            </div>
            <FileTable
                caption={m.files_title()}
                global
                nameCell={nameCell}
                files={list.data?.items}
                sort={search.sort}
                onSortChange={(sort) => {
                    update({ sort });
                }}
                filters={filtersOf(search)}
                onFiltersChange={(filters) => {
                    const purpose = filterValue(filters, 'purpose');
                    update({
                        purpose: FILE_PURPOSES.find((candidate) => candidate === purpose),
                        scan: filterValue(filters, 'scan'),
                    });
                }}
                page={paging.page}
                onPageChange={paging.onPageChange}
                onPageIntent={(cursor, direction) => {
                    if (direction !== 'next') return;
                    queryClient.query(fileListQueryOptions(engineApi, { ...params, cursor })).catch(() => undefined);
                }}
                loading={list.isPending}
                fetching={list.isFetching && !list.isPending}
                error={
                    list.isError && !invalidCursor
                        ? {
                              onRetry: () => {
                                  void list.refetch();
                              },
                              retrying: list.isFetching,
                          }
                        : null
                }
                empty={
                    hasFileFilters(search)
                        ? {
                              title: m.files_no_results(),
                              description: m.files_no_results_hint(),
                              action: <Button onClick={clear}>{m.files_clear_filters()}</Button>,
                          }
                        : { title: m.files_empty_title(), description: m.files_empty_body() }
                }
                {...(writable ? { rowActions } : {})}
            />
            {search.file === undefined ? null : (
                <FileDrawer
                    fileId={search.file}
                    onClose={() => {
                        void navigate({ search: (previous) => ({ ...previous, file: undefined }) });
                    }}
                />
            )}
            {search.upload === true && writable ? (
                <UploadKnowledgeDialog
                    onClose={() => {
                        void navigate({ search: (previous) => ({ ...previous, upload: undefined }), replace: true });
                    }}
                />
            ) : null}
            {deletion.dialog}
        </Page>
    );
}
