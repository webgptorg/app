import { AgentId, FILE_PURPOSES, FILE_SCAN_STATUSES } from '@ptbk/engine-api';
import type { FilePurpose } from '@ptbk/engine-api';
import { FilterBar, filterField } from '@ptbk/ui';
import type { DataTableView, FilterBarField } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Bot, ShieldCheck, Tag } from 'lucide-react';

import { useDebouncedSearch } from '../../app/debounced-search';
import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { readListParam, readOneParam, writeListParam } from '../../app/search-filters';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { agentListQueryOptions } from '../agents/agents-queries';
import { AGENT_CHOICES } from './agent-filter';
import { purposeIcon, purposeLabel, scanFieldOptions } from './file-labels';
import type { FilesSearch } from './files-search';
import { useFileScanning } from './use-file-scanning';

const ICON = 'size-3.5';

export type FileFilterSearch = Partial<Pick<FilesSearch, 'q' | 'scan' | 'purpose' | 'agentId'>>;

/**
 * The files' `FilterBar`, for `FileTable`'s toolbar. Every filter reads from and writes to the search params, so a
 * reload or a shared link restores the view. On an agent's Files tab (`scope="agent"`) the agent is given and its
 * sections stand for the purpose, so only the search and the scan remain.
 */
export function FileFilters({
    view,
    search,
    scope,
    onChange,
    onClear,
}: {
    readonly view: DataTableView;
    readonly search: FileFilterSearch;
    readonly scope: 'engine' | 'agent';
    readonly onChange: (change: FileFilterSearch, replace?: boolean) => void;
    readonly onClear: () => void;
}) {
    const scanning = useFileScanning();
    const [text, setText] = useDebouncedSearch(search.q, (q) => {
        onChange({ q }, true);
    });
    const agentsVisible = useAllows({ permission: 'agents.read' }) && scope === 'engine';
    const agents = useQuery({
        ...agentListQueryOptions(useEngineApi(), AGENT_CHOICES),
        enabled: agentsVisible,
    });
    const fields: FilterBarField[] = [
        ...(scope === 'engine'
            ? [
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
              ]
            : []),
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
                              <AgentAvatar
                                  name={agent.name}
                                  agentKey={agent.id}
                                  profile={agent.profile}
                                  origin={agent.origin}
                                  size="2xs"
                              />
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
