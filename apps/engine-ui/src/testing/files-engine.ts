import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { CapabilityRef, EngineApiClient, Permission } from '@ptbk/engine-api';
import { createInMemoryEngine, DEFAULT_CAPABILITIES } from '@ptbk/engine-api/in-memory';
import type {
    FileUploadPolicies,
    InMemoryEngineController,
    InMemorySeed,
    InMemorySeedFile,
} from '@ptbk/engine-api/in-memory';
import { vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { OWNER_ID } from './agents-engine';
import { TEST_NOW } from './test-engine-api';

/** A file name that must stay text: rendered as markup it would run a script. */
export const HOSTILE_FILE_NAME = '<img src=x onerror=alert(1)>.png';

export const FILE_IDS = {
    hostile: 'file-hostile',
    photo: 'file-photo',
    svg: 'file-svg',
    html: 'file-html',
    pdf: 'file-pdf',
    infected: 'file-infected',
    scanFailed: 'file-scan-failed',
    pending: 'file-pending',
    project: 'file-project',
    attachment: 'file-attachment',
} as const;

/** Knowledge files of Grace, so the global list and her Files tab have a second page. */
export const FILLER_FILES = 50;
export const COMMITS = { first: '1'.repeat(40), second: '2'.repeat(40) } as const;
export const PROJECT_RUN_ID = 'run-project';

const ago = (minutes: number) => new Date(TEST_NOW.getTime() - minutes * 60_000).toISOString();

function file(
    id: string,
    name: string,
    fields: Partial<InMemorySeedFile['metadata']> & { readonly minutesAgo: number },
): InMemorySeedFile {
    const { minutesAgo, ...metadata } = fields;
    return {
        metadata: {
            id,
            name,
            contentType: 'text/plain',
            sizeBytes: 2048,
            sha256: 'ab'.repeat(32),
            purpose: 'knowledge',
            agentId: 'agent-ada',
            chatId: null,
            runId: null,
            scan: { status: 'clean', checkedAt: ago(minutesAgo) },
            createdBy: OWNER_ID,
            createdAt: ago(minutesAgo),
            ...metadata,
        },
        content: new Blob(['content']),
    };
}

/** Two agents' knowledge and outputs in every scan state, the preview cases, a git-backed file and two pages. */
export function filesSeed(): InMemorySeed {
    const filler = Array.from({ length: FILLER_FILES }, (_, index) =>
        file(`file-note-${String(index + 1).padStart(3, '0')}`, `Note ${String(index + 1).padStart(3, '0')}.md`, {
            agentId: 'agent-grace',
            contentType: 'text/markdown',
            minutesAgo: 1000 + index,
        }),
    );
    const project = file(FILE_IDS.project, 'src/app.ts', {
        purpose: 'output',
        contentType: 'text/x-typescript',
        runId: PROJECT_RUN_ID,
        minutesAgo: 5,
    });
    return {
        engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
        agents: [
            { id: 'agent-ada', source: 'Ada\nPERSONA Research' },
            { id: 'agent-grace', source: 'Grace\nPERSONA Review' },
        ],
        files: [
            file(FILE_IDS.hostile, HOSTILE_FILE_NAME, { contentType: 'image/png', purpose: 'output', minutesAgo: 1 }),
            file(FILE_IDS.photo, 'photo.png', { contentType: 'image/png', purpose: 'output', minutesAgo: 2 }),
            file(FILE_IDS.svg, 'diagram.svg', { contentType: 'image/svg+xml', purpose: 'output', minutesAgo: 3 }),
            file(FILE_IDS.html, 'page.html', { contentType: 'text/html', minutesAgo: 4 }),
            {
                ...project,
                versions: [
                    {
                        version: {
                            id: 'version-project-1',
                            createdAt: ago(60),
                            sizeBytes: 1024,
                            sha256: 'cd'.repeat(32),
                            commitHash: COMMITS.first,
                            runId: PROJECT_RUN_ID,
                        },
                        content: new Blob(['first']),
                    },
                    {
                        version: {
                            id: 'version-project-2',
                            createdAt: ago(5),
                            sizeBytes: 2048,
                            sha256: 'ab'.repeat(32),
                            commitHash: COMMITS.second,
                            runId: PROJECT_RUN_ID,
                        },
                        content: new Blob(['second']),
                    },
                ],
            },
            file(FILE_IDS.pdf, 'report.pdf', { contentType: 'application/pdf', minutesAgo: 6 }),
            file(FILE_IDS.infected, 'invoice.png', {
                contentType: 'image/png',
                purpose: 'attachment',
                scan: { status: 'infected', checkedAt: ago(7) },
                minutesAgo: 7,
            }),
            file(FILE_IDS.scanFailed, 'archive.docx', {
                agentId: 'agent-grace',
                scan: { status: 'failed', checkedAt: ago(8) },
                minutesAgo: 8,
            }),
            file(FILE_IDS.pending, 'pending.txt', {
                agentId: null,
                purpose: 'upload',
                scan: { status: 'pending', checkedAt: null },
                minutesAgo: 9,
            }),
            ...filler,
        ],
    };
}

/** Knowledge is Markdown and plain text up to 1 kB, so the limits are easy to cross in a test. */
export const TEST_UPLOAD_POLICIES: FileUploadPolicies = {
    knowledge: { maxBytes: 1000, accept: ['.md', 'text/plain'] },
};

type FileMethods = EngineApiClient['files'];

export interface FilesEngine {
    /** Pass as `engineApi`; file methods are spies, so tests count, inspect and override calls. */
    readonly client: EngineApiClient;
    readonly controller: InMemoryEngineController;
    readonly spies: { readonly [Key in keyof FileMethods]: MockInstance<FileMethods[Key]> };
    /** The in-memory engine's own file methods, for overrides that delay or wrap them. */
    readonly original: FileMethods;
}

export interface FilesEngineOptions {
    readonly seed?: InMemorySeed;
    readonly permissions?: readonly Permission[];
    /** Every capability by default, scanning included; `scanning: false` drops only `file-scanning@1`. */
    readonly capabilities?: readonly CapabilityRef[];
    readonly scanning?: boolean;
}

export function createFilesEngine(options: FilesEngineOptions = {}): FilesEngine {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: options.seed ?? filesSeed(),
        uploadPolicies: TEST_UPLOAD_POLICIES,
        ...(options.permissions === undefined
            ? {}
            : { member: { id: OWNER_ID, permissions: options.permissions, role: 'member' } }),
        capabilities:
            options.capabilities ??
            (options.scanning === false ? DEFAULT_CAPABILITIES : Object.values(KNOWN_CAPABILITIES)),
    });
    const original = { ...engine.client.files };
    const files = { ...original };
    const spies = {
        list: vi.spyOn(files, 'list'),
        stats: vi.spyOn(files, 'stats'),
        uploadPolicy: vi.spyOn(files, 'uploadPolicy'),
        upload: vi.spyOn(files, 'upload'),
        get: vi.spyOn(files, 'get'),
        listVersions: vi.spyOn(files, 'listVersions'),
        download: vi.spyOn(files, 'download'),
        delete: vi.spyOn(files, 'delete'),
    };
    return { client: { ...engine.client, files }, controller: engine.controller, spies, original };
}
