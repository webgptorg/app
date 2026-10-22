import { AgentId, DEFAULT_PAGE_LIMIT, FILE_SCAN_STATUSES, FILE_SORTS, FileId, FilePurpose } from '@ptbk/engine-api';
import { z } from 'zod';

import type { FileListParams } from './files-keys';

export type FileSort = (typeof FILE_SORTS)[number];
export const DEFAULT_FILE_SORT: FileSort = '-createdAt';
/** The attention item's filter: every file whose scan needs a member to look at it. */
export const SCAN_PROBLEMS = 'infected,failed';

const STATUS = FILE_SCAN_STATUSES.join('|');
const SCAN_SET = new RegExp(`^(?:${STATUS})(?:,(?:${STATUS}))*$`);

// The router reads search values as JSON, so an all-digit ID arrives as a number.
const idParam = <Schema extends z.ZodType<string>>(schema: Schema) =>
    z.preprocess((value) => (typeof value === 'number' ? String(value) : value), schema);

const cursor = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,1024}$/)
    .optional()
    .catch(undefined);

/** Shared by both views. Not strict, and a bad value falls back to "no filter" instead of throwing. */
const common = {
    q: z.string().trim().min(1).max(255).optional().catch(undefined),
    /** One scan status or a comma-separated set, sent to the engine as it is. */
    scan: z.string().max(128).regex(SCAN_SET).optional().catch(undefined),
    sort: z.enum(FILE_SORTS).default(DEFAULT_FILE_SORT).catch(DEFAULT_FILE_SORT),
    /** The file whose details are open, so the drawer survives a reload and the back button. */
    file: idParam(FileId).optional().catch(undefined),
};

/** `/files`: every file the member can see. */
export const FilesSearch = z.object({
    ...common,
    purpose: FilePurpose.optional().catch(undefined),
    agentId: idParam(AgentId).optional().catch(undefined),
    cursor,
    /** Opens the "Upload knowledge" dialog. */
    upload: z.literal(true).optional().catch(undefined),
});
export type FilesSearch = z.output<typeof FilesSearch>;

export const AGENT_FILE_SECTIONS = ['knowledge', 'other'] as const;
export type AgentFileSection = (typeof AGENT_FILE_SECTIONS)[number];

/** `/agents/$agentId/files`: the agent's knowledge first, then everything else, one section at a time. */
export const AgentFilesSearch = z.object({
    ...common,
    section: z.enum(AGENT_FILE_SECTIONS).default('knowledge').catch('knowledge'),
    cursor,
});
export type AgentFilesSearch = z.output<typeof AgentFilesSearch>;

type Filters = Pick<FileListParams, 'agentId' | 'purpose' | 'q' | 'scan' | 'sort' | 'cursor'>;

/** Everything goes to the engine; the UI never filters or sorts files itself. */
export function fileListParams(filters: Filters): FileListParams {
    return {
        limit: DEFAULT_PAGE_LIMIT,
        sort: filters.sort ?? DEFAULT_FILE_SORT,
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
        ...(filters.purpose === undefined ? {} : { purpose: filters.purpose }),
        ...(filters.q === undefined ? {} : { q: filters.q }),
        ...(filters.scan === undefined ? {} : { scan: filters.scan }),
        ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
    };
}

export function hasFileFilters(search: Pick<FilesSearch, 'q' | 'scan'> & Partial<FilesSearch>): boolean {
    return (
        search.q !== undefined ||
        search.scan !== undefined ||
        search.purpose !== undefined ||
        search.agentId !== undefined
    );
}
