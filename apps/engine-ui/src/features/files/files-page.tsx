import { AgentId, FILE_PURPOSES, FILE_SCAN_STATUSES } from '@ptbk/engine-api';
import type { FileMetadata, FilePurpose } from '@ptbk/engine-api';
import { Button, Dialog, FilterBar, filterField } from '@ptbk/ui';
import type { ColumnFiltersState, DataTableView, FilterBarField, MenuEntry } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Bot, Files, PanelRightOpen, ShieldCheck, Tag, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { useCursorPages } from '../../app/cursor-pages';
import { useDebouncedSearch } from '../../app/debounced-search';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { isInvalidCursor } from '../../app/list-errors';
import { useAllows } from '../../app/registry/use-visible-features';
import { readListParam, readOneParam, writeListParam } from '../../app/search-filters';
import { SoftBreaks } from '../../app/soft-breaks';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { agentListQueryOptions } from '../agents/agents-queries';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import { AGENT_CHOICES, AgentSelect } from './agent-filter';
import { useFileDelete } from './file-delete';
import { FileDrawer } from './file-drawer';
import { purposeIcon, purposeLabel, scanFieldOptions } from './file-labels';
import { FileTable } from './file-table';
import { fileListQueryOptions, useFiles } from './files-queries';
import { fileListParams, hasFileFilters } from './files-search';
import type { FilesSearch } from './files-search';
import { KnowledgeUpload } from './knowledge-upload';
import { useFileScanning } from './use-file-scanning';

const route = getRouteApi('/files');
const ICON = 'size-3.5';
// The filter bar owns every filter; the columns have none of their own to report.
const NO_COLUMN_FILTERS: ColumnFiltersState = [];
const NO_FILTERS = { q: undefined, purpose: undefined, scan: undefined, agentId: undefined } as const;

function UploadKnowledgeDialog({ onClose }: { readonly onClose: () => void }) {
    const [agentId, setAgentId] = useState<FileMetadata['agentId']>(null);
    return (
        <Dialog open onClose={onClose} title={m.files_upload_title()} size="lg">
            <div className="flex flex-col gap-4">
                <AgentSelect
                    label={m.files_upload_agent()}
                    placeholder={m.files_upload_pick_agent()}
                    value={agentId ?? undefined}
                    onChange={(chosen) => {
                        setAgentId(chosen ?? null);
                    }}
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

    const update = useCallback(
        (change: Partial<FilesSearch>, replace = false) => {
            void navigate({ search: (previous) => ({ ...previous, cursor: undefined, ...change }), replace });
        },
        [navigate],
    );
    const paging = useCursorPages(search.cursor, list.data?.nextCursor ?? null, (cursor) => {
        void navigate({ search: (previous) => ({ ...previous, cursor }) });
    });
    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        if (invalidCursor) void navigate({ search: (previous) => ({ ...previous, cursor: undefined }), replace: true });
    }, [invalidCursor, navigate]);

    const clear = () => {
        update(NO_FILTERS);
    };
    const openFile = (file: FileMetadata) => {
        void navigate({ search: (previous) => ({ ...previous, file: file.id }) });
    };
    const nameCell = useCallback(
        (file: FileMetadata) => (
            <Link
                to="/files"
                search={{ ...search, file: file.id }}
                variant="standalone"
                className="line-clamp-2 font-medium break-words text-text"
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
            id: 'details',
            label: m.files_detail_title(),
            icon: <PanelRightOpen />,
            onSelect: () => {
                openFile(file);
            },
        },
        ...(writable
            ? ([
                  { kind: 'separator', id: 'danger' },
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
              ] satisfies MenuEntry[])
            : []),
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
            <FileTable
                caption={m.files_title()}
                global
                nameCell={nameCell}
                files={list.data?.items}
                sort={search.sort}
                onSortChange={(sort) => {
                    update({ sort });
                }}
                filters={NO_COLUMN_FILTERS}
                onFiltersChange={() => undefined}
                toolbar={(view) => <FileFilters view={view} search={search} onChange={update} onClear={clear} />}
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
                        : { icon: <Files />, title: m.files_empty_title(), description: m.files_empty_body() }
                }
                rowActions={rowActions}
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

/** Every filter reads from and writes to the search params, so a reload or a shared link restores the view. */
function FileFilters({
    view,
    search,
    onChange,
    onClear,
}: {
    readonly view: DataTableView;
    readonly search: FilesSearch;
    readonly onChange: (change: Partial<FilesSearch>, replace?: boolean) => void;
    readonly onClear: () => void;
}) {
    const scanning = useFileScanning();
    const [text, setText] = useDebouncedSearch(search.q, (q) => {
        onChange({ q }, true);
    });
    const agentsVisible = useAllows({ permission: 'agents.read' });
    const agents = useQuery({
        ...agentListQueryOptions(useEngineApi(), AGENT_CHOICES),
        enabled: agentsVisible,
    });
    const fields: FilterBarField[] = [
        filterField.enum<FilePurpose>({
            id: 'purpose',
            label: m.files_column_purpose(),
            icon: <Tag className={ICON} />,
            options: FILE_PURPOSES.map((purpose) => ({
                value: purpose,
                label: purposeLabel(purpose),
                icon: <span className="flex [&>svg]:size-3.5">{purposeIcon(purpose)}</span>,
            })),
            value: search.purpose,
            onChange: (purpose) => {
                onChange({ purpose });
            },
        }),
        ...(agentsVisible
            ? [
                  filterField.entity<string>({
                      id: 'agent',
                      label: m.files_filter_agent(),
                      icon: <Bot className={ICON} />,
                      multiple: false,
                      options: (agents.data?.items ?? []).map((agent) => ({
                          value: agent.id,
                          label: agent.name,
                          icon: (
                              <AgentAvatar name={agent.name} agentKey={agent.id} profile={agent.profile} size="2xs" />
                          ),
                      })),
                      value: readOneParam(search.agentId),
                      onChange: (value) => {
                          // An agent beyond the first page stays selected by its ID from the URL until it is removed.
                          const picked = value.at(-1);
                          onChange({ agentId: picked === undefined ? undefined : AgentId.safeParse(picked).data });
                      },
                  }),
              ]
            : []),
        ...(scanning
            ? [
                  filterField.multiEnum({
                      id: 'scan',
                      label: m.files_column_scan(),
                      icon: <ShieldCheck className={ICON} />,
                      options: scanFieldOptions(),
                      value: readListParam(search.scan, FILE_SCAN_STATUSES),
                      onChange: (value) => {
                          onChange({ scan: writeListParam(value, FILE_SCAN_STATUSES) });
                      },
                  }),
              ]
            : []),
    ];
    return (
        <FilterBar
            {...view}
            label={m.files_filters()}
            search={{
                label: m.files_search_label(),
                value: text,
                onChange: setText,
                maxLength: 255,
            }}
            fields={fields}
            onClear={() => {
                setText('');
                onClear();
            }}
        />
    );
}
