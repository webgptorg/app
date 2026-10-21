import type { FileId, FileMetadata, FileVersion } from '@ptbk/engine-api';
import { Button, CodeText, Drawer, ErrorState, RelativeTime, Skeleton, useLocale } from '@ptbk/ui';
import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { canPreviewImage } from '../../security/safe-preview';
import { AgentCreator } from '../agents/agent-creator';
import { usePermissions } from '../session/use-permissions';
import { fileContentPath } from './file-content';
import { useFileDelete } from './file-delete';
import { FileDownload } from './file-download';
import { PurposeBadge, ScanBadge } from './file-labels';
import { AgentName, RunLink, useRunLinks } from './file-origin';
import { formatBytes } from './file-size';
import { useFile, useFileVersions } from './files-queries';

const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 240;

function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <dt className="text-xs font-medium text-text-muted">{term}</dt>
            <dd className="min-w-0 text-sm break-words">{children}</dd>
        </div>
    );
}

/**
 * A raster image from the content route, only for the four types `canPreviewImage` allows and a clean scan. Fixed
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
            className="h-60 w-80 max-w-full rounded-control border border-border bg-sunken object-contain"
        />
    );
}

function Versions({ file }: { readonly file: FileMetadata }) {
    const formatters = useLocale();
    const versions = useFileVersions(file.id);
    const runLinks = useRunLinks();
    if (versions.isPending) return <Skeleton shape="block" className="h-24 w-full" />;
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
    const items = versions.data.items;
    return (
        <ol aria-label={m.files_versions()} className="flex flex-col gap-3">
            {items.map((version: FileVersion, index) => (
                <li key={version.id} className="flex flex-col gap-2 rounded-control border border-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="font-medium">
                            {index === 0 ? m.files_version_current() : m.files_version_earlier()}
                        </span>
                        <RelativeTime value={new Date(version.createdAt)} />
                    </div>
                    <dl className="grid gap-2 sm:grid-cols-2">
                        <Fact term={m.files_column_size()}>{formatBytes(formatters, version.sizeBytes)}</Fact>
                        {version.commitHash === null ? null : (
                            <Fact term={m.files_field_commit()}>
                                <CodeText value={version.commitHash} copyable copyLabel={m.files_copy_commit()} />
                            </Fact>
                        )}
                        {version.runId !== null && runLinks ? (
                            <Fact term={m.files_field_run()}>
                                <RunLink runId={version.runId} />
                            </Fact>
                        ) : null}
                    </dl>
                    <FileDownload
                        file={file}
                        versionId={version.id}
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

function Details({ file, onDeleted }: { readonly file: FileMetadata; readonly onDeleted: () => void }) {
    const formatters = useLocale();
    const { can } = usePermissions();
    const runLinks = useRunLinks();
    const deletion = useFileDelete(onDeleted);
    return (
        <div className="flex flex-col gap-6">
            <p className="text-lg font-semibold break-all">{file.name}</p>
            <FilePreview file={file} />
            <div className="flex flex-wrap items-start gap-3">
                <FileDownload file={file} />
                {can('files.write') ? (
                    <Button
                        variant="danger"
                        size="sm"
                        onClick={() => {
                            deletion.request(file);
                        }}
                    >
                        <Trash2 aria-hidden className="size-4" />
                        {m.files_delete()}
                    </Button>
                ) : null}
            </div>
            <dl className="grid gap-4 sm:grid-cols-2">
                <Fact term={m.files_column_purpose()}>
                    <PurposeBadge purpose={file.purpose} />
                </Fact>
                <Fact term={m.files_column_scan()}>
                    <span className="flex flex-wrap items-center gap-2">
                        <ScanBadge status={file.scan.status} />
                        {file.scan.checkedAt === null ? null : <RelativeTime value={new Date(file.scan.checkedAt)} />}
                    </span>
                </Fact>
                <Fact term={m.files_column_type()}>
                    <span className="break-all">{file.contentType}</span>
                </Fact>
                <Fact term={m.files_column_size()}>{formatBytes(formatters, file.sizeBytes)}</Fact>
                <Fact term={m.files_column_agent()}>
                    <AgentName agentId={file.agentId} />
                </Fact>
                {file.chatId !== null && file.agentId !== null ? (
                    <Fact term={m.files_field_chat()}>
                        <Link
                            to="/agents/$agentId/chat/$chatId"
                            params={{ agentId: file.agentId, chatId: file.chatId }}
                            variant="standalone"
                        >
                            {m.files_open_chat()}
                        </Link>
                    </Fact>
                ) : null}
                {file.runId !== null && runLinks ? (
                    <Fact term={m.files_field_run()}>
                        <RunLink runId={file.runId} />
                    </Fact>
                ) : null}
                <Fact term={m.files_column_created_by()}>
                    <AgentCreator memberId={file.createdBy} />
                </Fact>
                <Fact term={m.files_column_created()}>
                    <RelativeTime value={new Date(file.createdAt)} />
                </Fact>
                <Fact term={m.files_field_sha256()}>
                    <CodeText value={file.sha256} group={8} copyable copyLabel={m.files_copy_sha256()} />
                </Fact>
            </dl>
            <section aria-labelledby="file-versions" className="flex flex-col gap-3">
                <h3 id="file-versions" className="text-base font-semibold">
                    {m.files_versions()}
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
