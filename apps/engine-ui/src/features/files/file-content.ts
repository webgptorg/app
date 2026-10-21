import { ENGINE_API_PREFIX } from '@ptbk/engine-api';
import type { FileId, FileVersionId } from '@ptbk/engine-api';

/**
 * The same-origin content route for a file or one version. Built from the encoded IDs only: names and types are
 * agent or member content and never become part of a URL.
 */
export function fileContentPath(fileId: FileId, versionId?: FileVersionId): string {
    const path = `${ENGINE_API_PREFIX}/files/${encodeURIComponent(fileId)}/content`;
    return versionId === undefined ? path : `${path}?${new URLSearchParams({ version: versionId }).toString()}`;
}
