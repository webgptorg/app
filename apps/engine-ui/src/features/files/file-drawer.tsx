import type { FileId, FileMetadata, FileVersion } from '@ptbk/engine-api';
import {
    ActionMenu,
    CopyButton,
    Drawer,
    ErrorState,
    RelativeTime,
    Skeleton,
    TechnicalDetails,
    useLocale,
} from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { FolderOpen, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { SoftBreaks } from '../../app/soft-breaks';
import { m } from '../../paraglide/messages';
import { canPreviewImage } from '../../security/safe-preview';
import { AgentCreator } from '../agents/agent-creator';
import { chatQueryOptions } from '../chat/chat-queries';
import { EntityChip } from '../entities/entity-chip';
import { usePermissions } from '../session/use-permissions';
import { fileContentPath } from './file-content';
import { useFileDelete } from './file-delete';
import { FileDownload } from './file-download';
import { PurposeBadge, ScanBadge } from './file-labels';
import { FileAgent, useRunLinks } from './file-origin';
import { formatBytes } from './file-size';
import { FileTypeIcon } from './file-type-icon';
import { useFile, useFileVersions } from './files-queries';

const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 240;

/** One fact: its name quiet on the left, the value beside it, narrow enough for the drawer. */
function Property({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-4 py-1.5">
            <dt className="text-sm text-text-subtle">{label}</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm break-words">{children}</dd>
        </div>
    );
}

function DateTime({ at }: { readonly at: string }) {
    const locale = useLocale();
    return (
        <time dateTime={at} className="tabular-nums">
            {locale.formatDateTime(new Date(at))}
        </time>
    );
}

/**
 * A raster image from the content route, only for the four types `canPreviewImage` allows and never an unclean scan. Fixed
 * dimensions keep the layout still while it loads; the alt text is the file name, as text.
 */
export function FilePreview({ file }: { readonly file: FileMetadata }) {
    if (!canPreviewImage(file)) return null;
    return (
        <img
            src={fileContentPath(file.id)}
            alt={file.name}
            width={PREVIEW_WIDTH}
            height={PREVIEW_HEIGHT}
            loading="lazy"
            decoding="async"
            className="h-60 w-80 max-w-full rounded-control border border-hairline bg-sunken object-contain"
        />
    );
}

/** The chat a file came from, by its title once the engine confirms it, as a chip that opens it. */
function FileChat({ chatId }: { readonly chatId: NonNullable<FileMetadata['chatId']> }) {
    const allowed = useAllows({ permission: 'chats.read' });
    const chat = useQuery({ ...chatQueryOptions(useEngineApi(), chatId), enabled: allowed });
    return <EntityChip kind="chat" id={chatId} name={chat.data?.title ?? m.files_field_chat()} />;
}

function Versions({ file }: { readonly file: FileMetadata }) {
    const formatters = useLocale();
    const versions = useFileVersions(file.id);
    const runLinks = useRunLinks();
    if (versions.isPending) return <Skeleton shape="block" className="h-16 w-full" />;
    if (versions.isError) {
        return (
            <ErrorState
                message={m.files_versions_failed()}
                onRetry={() => {
                    void versions.refetch();
                }}
            />
        );
    }
    return (
        <ol aria-label={m.files_versions()} className="flex flex-col divide-y divide-hairline">
            {versions.data.items.map((version: FileVersion, index) => (
                <li key={version.id} className="flex items-start gap-3 py-2">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                            <span className="font-medium">
                                {index === 0 ? m.files_version_current() : m.files_version_earlier()}
                            </span>
                            <RelativeTime
                                value={new Date(version.createdAt)}
                                className="text-xs text-text-muted tabular-nums"
                            />
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
                            <span className="tabular-nums">{formatBytes(formatters, version.sizeBytes)}</span>
                            {version.commitHash === null ? null : (
                                <span className="inline-flex min-w-0 items-center gap-0.5">
                                    {/* The whole hash stays in the text for find-in-page; the eye needs only its start. */}
                                    <code className="max-w-[10ch] truncate font-mono text-xs text-text">
                                        {version.commitHash}
                                    </code>
                                    <CopyButton value={version.commitHash} label={m.files_copy_commit()} size="sm" />
                                </span>
                            )}
                            {version.runId !== null && runLinks ? (
                                <EntityChip kind="run" id={version.runId} name={m.files_field_run()} />
                            ) : null}
                        </div>
                    </div>
                    <FileDownload
                        file={file}
                        versionId={version.id}
                        variant="ghost"
                        label={m.files_download_version({
                            name: file.name,
                            date: formatters.formatDateTime(new Date(version.createdAt)),
                        })}
                    />
                </li>
            ))}
        </ol>
    );
}

function FileMenu({ file, onDelete }: { readonly file: FileMetadata; readonly onDelete: () => void }) {
    const { can } = usePermissions();
    const navigate = useNavigate();
    const agentsVisible = useAllows({ permission: 'agents.read' });
    const agentId = file.agentId;
    const open: readonly MenuEntry[] =
        agentId !== null && agentsVisible
            ? [
                  {
                      kind: 'item',
                      id: 'agent-files',
                      label: m.files_open_agent_files(),
                      icon: <FolderOpen aria-hidden />,
                      onSelect: () => {
                          void navigate({
                              to: '/agents/$agentId/files',
                              params: { agentId },
                              search: { file: file.id },
                          });
                      },
                  },
              ]
            : [];
    const remove: readonly MenuEntry[] = can('files.write')
        ? [
              {
                  kind: 'item',
                  id: 'delete',
                  label: m.files_delete(),
                  icon: <Trash2 aria-hidden />,
                  tone: 'danger',
                  onSelect: onDelete,
              },
          ]
        : [];
    const items = [
        ...open,
        ...(open.length > 0 && remove.length > 0 ? [{ kind: 'separator', id: 'danger' } as const] : []),
        ...remove,
    ];
    return <ActionMenu items={items} size="sm" variant="ghost" />;
}

function Details({ file, onDeleted }: { readonly file: FileMetadata; readonly onDeleted: () => void }) {
    const formatters = useLocale();
    const runLinks = useRunLinks();
    const deletion = useFileDelete(onDeleted);
    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
                <div className="flex items-start gap-2.5">
                    <FileTypeIcon contentType={file.contentType} className="mt-1" />
                    <p className="min-w-0 text-base font-semibold break-all">{file.name}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                    <PurposeBadge purpose={file.purpose} />
                    {/* `null` on an engine that does not scan: no pill at all, rather than a status nobody can act on. */}
                    {file.scan === null ? null : <ScanBadge status={file.scan.status} />}
                </div>
            </div>
            <FilePreview file={file} />
            <div className="flex flex-wrap items-start gap-2">
                <FileDownload file={file} />
                <FileMenu
                    file={file}
                    onDelete={() => {
                        deletion.request(file);
                    }}
                />
            </div>
            <dl className="flex flex-col border-t border-hairline pt-3">
                <Property label={m.files_column_agent()}>
                    <FileAgent agentId={file.agentId} />
                </Property>
                <Property label={m.files_column_type()}>
                    <span className="text-text-muted">
                        <SoftBreaks text={file.contentType} after="/+" />
                    </span>
                </Property>
                <Property label={m.files_column_size()}>
                    <span className="tabular-nums">{formatBytes(formatters, file.sizeBytes)}</span>
                </Property>
                {file.scan?.checkedAt == null ? null : (
                    <Property label={m.files_field_scanned()}>
                        <RelativeTime value={new Date(file.scan.checkedAt)} className="tabular-nums" />
                    </Property>
                )}
                {file.chatId === null ? null : (
                    <Property label={m.files_field_chat()}>
                        <FileChat chatId={file.chatId} />
                    </Property>
                )}
                {file.runId !== null && runLinks ? (
                    <Property label={m.files_field_run()}>
                        <EntityChip kind="run" id={file.runId} name={m.files_field_run()} />
                    </Property>
                ) : null}
                <Property label={m.files_column_created_by()}>
                    <AgentCreator memberId={file.createdBy} />
                </Property>
                <Property label={m.files_column_created()}>
                    <DateTime at={file.createdAt} />
                </Property>
            </dl>
            <TechnicalDetails items={[{ label: m.files_field_sha256(), value: file.sha256 }]} />
            <section aria-labelledby="file-versions" className="flex flex-col gap-1 border-t border-hairline pt-4">
                <h3 id="file-versions" className="text-sm font-semibold">
                    {m.files_versions()}{' '}
                    <span className="ms-1 font-medium text-text-muted tabular-nums">{file.versionCount}</span>
                </h3>
                <Versions file={file} />
            </section>
            {deletion.dialog}
        </div>
    );
}

function isNotFound(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.status === 404;
}

/** The file's details beside the list; its ID is in the URL, so the drawer survives a reload and the back button. */
export function FileDrawer({ fileId, onClose }: { readonly fileId: FileId; readonly onClose: () => void }) {
    const file = useFile(fileId);
    let body: ReactNode;
    if (file.isPending) body = <Skeleton shape="block" className="h-64 w-full" />;
    else if (file.isError) {
        body = isNotFound(file.error) ? (
            <p className="text-sm">{m.files_not_found()}</p>
        ) : (
            <ErrorState
                message={m.files_detail_failed()}
                onRetry={() => {
                    void file.refetch();
                }}
            />
        );
    } else body = <Details file={file.data} onDeleted={onClose} />;
    return (
        <Drawer open onClose={onClose} title={m.files_detail_title()}>
            {body}
        </Drawer>
    );
}
