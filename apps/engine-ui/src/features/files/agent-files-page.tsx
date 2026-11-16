import type { AgentId, FileMetadata } from '@ptbk/engine-api';
import { Button, Tabs } from '@ptbk/ui';
import type { ColumnFiltersState, MenuEntry } from '@ptbk/ui';
import { getRouteApi } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect } from 'react';

import { useCursorPages } from '../../app/cursor-pages';
import { Link } from '../../app/link';
import { isInvalidCursor } from '../../app/list-errors';
import { SoftBreaks } from '../../app/soft-breaks';
import { m } from '../../paraglide/messages';
import { useAgentIdParam } from '../agents/agent-detail-route';
import { usePermissions } from '../session/use-permissions';
import { useFileDelete } from './file-delete';
import { FileDrawer } from './file-drawer';
import { FileFilters } from './file-filters';
import { FileTable } from './file-table';
import { useFiles } from './files-queries';
import { AGENT_FILE_SECTIONS, fileListParams } from './files-search';
import type { AgentFileSection, AgentFilesSearch } from './files-search';
import { KnowledgeUpload } from './knowledge-upload';

const route = getRouteApi('/agents/$agentId/files');
// The toolbar's FilterBar holds the scan filter; the columns carry none of their own.
const NO_COLUMN_FILTERS: ColumnFiltersState = [];

/** What each section lists: the agent's knowledge, or what it produced and received (outputs, attachments, uploads). */
const SECTION_PURPOSES: Readonly<Record<AgentFileSection, string>> = {
    knowledge: 'knowledge',
    other: 'output,attachment,upload',
};

function sectionLabel(section: AgentFileSection): string {
    switch (section) {
        case 'knowledge':
            return m.files_section_knowledge();
        case 'other':
            return m.files_section_other();
    }
}

interface SectionProps {
    readonly agentId: AgentId;
    readonly section: AgentFileSection;
    readonly onChange: (change: Partial<AgentFilesSearch>, replace?: boolean) => void;
    readonly onClear: () => void;
    readonly rowActions: ((file: FileMetadata) => readonly MenuEntry[]) | undefined;
}

function FileSection({ agentId, section, onChange, onClear, rowActions }: SectionProps) {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const list = useFiles(fileListParams({ ...search, agentId, purpose: SECTION_PURPOSES[section] }));
    const paging = useCursorPages(search.cursor, list.data?.nextCursor ?? null, (cursor) => {
        void navigate({ search: (previous) => ({ ...previous, cursor }) });
    });
    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        if (invalidCursor) void navigate({ search: (previous) => ({ ...previous, cursor: undefined }), replace: true });
    }, [invalidCursor, navigate]);
    const nameCell = useCallback(
        (file: FileMetadata) => (
            <Link
                to="/agents/$agentId/files"
                params={{ agentId }}
                search={{ ...search, file: file.id }}
                variant="standalone"
                className="line-clamp-2 max-w-md font-medium break-words"
            >
                <SoftBreaks text={file.name} after="_" />
            </Link>
        ),
        [agentId, search],
    );
    const filtered = search.q !== undefined || search.scan !== undefined;
    return (
        <FileTable
            caption={sectionLabel(section)}
            global={false}
            nameCell={nameCell}
            files={list.data?.items}
            sort={search.sort}
            onSortChange={(sort) => {
                void navigate({ search: (previous) => ({ ...previous, sort, cursor: undefined }) });
            }}
            filters={NO_COLUMN_FILTERS}
            onFiltersChange={() => undefined}
            toolbar={(view) => (
                <FileFilters view={view} search={search} scope="agent" onChange={onChange} onClear={onClear} />
            )}
            page={paging.page}
            onPageChange={paging.onPageChange}
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
                filtered
                    ? {
                          title: m.files_no_results(),
                          description: m.files_no_results_hint(),
                          action: <Button onClick={onClear}>{m.files_clear_filters()}</Button>,
                      }
                    : section === 'knowledge'
                      ? { title: m.files_knowledge_empty_title(), description: m.files_knowledge_empty_body() }
                      : { title: m.files_other_empty_title(), description: m.files_other_empty_body() }
            }
            {...(rowActions === undefined ? {} : { rowActions })}
        />
    );
}

/** An agent's files: its knowledge first (with upload where permitted), then what it produced and received. */
export function AgentFilesPage() {
    const agentId = useAgentIdParam();
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const { can } = usePermissions();
    const deletion = useFileDelete();
    const update = (change: Partial<AgentFilesSearch>, replace = false) => {
        void navigate({ search: (previous) => ({ ...previous, cursor: undefined, ...change }), replace });
    };
    const clear = () => {
        update({ q: undefined, scan: undefined });
    };
    const writable = can('files.write');
    const rowActions = writable
        ? (file: FileMetadata): readonly MenuEntry[] => [
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
          ]
        : undefined;
    // The list first, then a quiet drop area under it: adding knowledge is the second thing anyone does here.
    const panel = (section: AgentFileSection) =>
        search.section === section ? (
            <div className="flex flex-col gap-4">
                <FileSection
                    agentId={agentId}
                    section={section}
                    onChange={update}
                    onClear={clear}
                    rowActions={rowActions}
                />
                {section === 'knowledge' && writable ? (
                    <section aria-label={m.files_upload_knowledge()}>
                        <KnowledgeUpload agentId={agentId} />
                    </section>
                ) : null}
            </div>
        ) : null;

    return (
        <div className="flex flex-col gap-3">
            <Tabs
                label={m.files_sections()}
                selectedId={search.section}
                onSelect={(id) => {
                    const section = AGENT_FILE_SECTIONS.find((candidate) => candidate === id);
                    if (section !== undefined) update({ section });
                }}
                tabs={AGENT_FILE_SECTIONS.map((section) => ({
                    id: section,
                    label: sectionLabel(section),
                    panel: panel(section),
                }))}
            />
            {search.file === undefined ? null : (
                <FileDrawer
                    fileId={search.file}
                    onClose={() => {
                        void navigate({ search: (previous) => ({ ...previous, file: undefined }) });
                    }}
                />
            )}
            {deletion.dialog}
        </div>
    );
}
