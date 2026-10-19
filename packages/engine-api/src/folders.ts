import { z } from 'zod';

import { FolderId, PageQuery, Timestamp, pageOf } from './common';
import { defineRoute } from './route';

export const FolderName = z.string().trim().min(1).max(128);

export const Folder = z.strictObject({
    id: FolderId,
    name: FolderName,
    createdAt: Timestamp,
    updatedAt: Timestamp,
});
export type Folder = z.infer<typeof Folder>;
export const FolderPage = pageOf(Folder);

export const FolderParams = z.strictObject({ folderId: FolderId });
export const FolderBody = z.strictObject({ name: FolderName });

export const FOLDER_ROUTES = {
    listFolders: defineRoute({
        id: 'listFolders',
        method: 'GET',
        path: '/folders',
        summary: 'List folders by name',
        permission: 'agents.read',
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: FolderPage } },
    }),
    createFolder: defineRoute({
        id: 'createFolder',
        method: 'POST',
        path: '/folders',
        summary: 'Create a folder',
        permission: 'agents.write',
        body: { kind: 'json', schema: FolderBody },
        responses: { 201: { kind: 'json', schema: Folder } },
        problems: ['name-taken'],
    }),
    renameFolder: defineRoute({
        id: 'renameFolder',
        method: 'PATCH',
        path: '/folders/{folderId}',
        summary: 'Rename a folder',
        permission: 'agents.write',
        params: FolderParams,
        body: { kind: 'json', schema: FolderBody },
        responses: { 200: { kind: 'json', schema: Folder } },
        problems: ['name-taken'],
    }),
    deleteFolder: defineRoute({
        id: 'deleteFolder',
        method: 'DELETE',
        path: '/folders/{folderId}',
        summary: 'Delete an empty folder; soft-deleted agents still count',
        permission: 'agents.write',
        params: FolderParams,
        responses: { 204: { kind: 'empty' } },
        problems: ['folder-not-empty'],
    }),
} as const;
