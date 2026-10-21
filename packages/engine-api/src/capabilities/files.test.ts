import { describe, expect, it } from 'vitest';

import { MAX_FILE_BYTES } from '../constants';
import { acceptsFile, FileAcceptToken, FileListQuery, FileStats, FileUploadPolicy } from './files';

describe('FileListQuery sets (API 1.6)', () => {
    it('reads one value or a comma-separated set as the set’s values, without duplicates', () => {
        expect(FileListQuery.parse({ scan: 'infected' }).scan).toEqual(['infected']);
        expect(FileListQuery.parse({ scan: 'infected,failed,infected' }).scan).toEqual(['infected', 'failed']);
        expect(FileListQuery.parse({ purpose: 'attachment,upload' }).purpose).toEqual(['attachment', 'upload']);
        expect(FileListQuery.parse({}).scan).toBeUndefined();
    });

    it.each(['', 'infected,', ',failed', 'infected,,failed', 'Infected', 'infected,bogus', 'infected failed'])(
        'rejects %j',
        (scan) => {
            expect(FileListQuery.safeParse({ scan }).success).toBe(false);
        },
    );
});

describe('FileStats', () => {
    const stats = {
        byPurpose: { knowledge: 1, attachment: 0, output: 2, upload: 0 },
        byScan: { pending: 0, clean: 2, infected: 1, failed: 0 },
    };

    it('needs every known purpose and scan status, and nothing else', () => {
        expect(FileStats.parse(stats)).toEqual(stats);
        expect(FileStats.safeParse({ ...stats, byScan: { ...stats.byScan, failed: undefined } }).success).toBe(false);
        expect(FileStats.safeParse({ ...stats, byPurpose: { ...stats.byPurpose, other: 1 } }).success).toBe(false);
        expect(FileStats.safeParse({ ...stats, byScan: { ...stats.byScan, clean: -1 } }).success).toBe(false);
    });
});

describe('FileUploadPolicy', () => {
    it('caps maxBytes at the contract’s MAX_FILE_BYTES', () => {
        const policy = { purpose: 'knowledge', maxBytes: MAX_FILE_BYTES, accept: [] };
        expect(FileUploadPolicy.parse(policy)).toEqual(policy);
        expect(FileUploadPolicy.safeParse({ ...policy, maxBytes: MAX_FILE_BYTES + 1 }).success).toBe(false);
        expect(FileUploadPolicy.safeParse({ ...policy, maxBytes: 0 }).success).toBe(false);
    });

    it.each(['.pdf', '.tar.gz', 'text/plain', 'image/*', 'application/vnd.ms-excel', 'image/svg+xml'])(
        'accepts the accept token %j',
        (token) => {
            expect(FileAcceptToken.safeParse(token).success).toBe(true);
        },
    );

    it.each(['', 'pdf', '.', '.PDF', 'Text/Plain', '*/*', 'text/', 'text/plain; charset=utf-8', 'image/*,.pdf'])(
        'rejects the accept token %j',
        (token) => {
            expect(FileAcceptToken.safeParse(token).success).toBe(false);
        },
    );
});

describe('acceptsFile', () => {
    const accept = ['.md', 'text/plain', 'image/*'];

    it('takes anything when the list is empty', () => {
        expect(acceptsFile([], { name: 'x', type: '' })).toBe(true);
    });

    it('matches the extension case-insensitively, never a bare extension name', () => {
        expect(acceptsFile(accept, { name: 'Notes.MD', type: '' })).toBe(true);
        expect(acceptsFile(accept, { name: '.md', type: '' })).toBe(false);
        expect(acceptsFile(accept, { name: 'notes.md.exe', type: '' })).toBe(false);
    });

    it('matches the media type without parameters, and a range by its top-level type', () => {
        expect(acceptsFile(accept, { name: 'a', type: 'Text/Plain; charset=utf-8' })).toBe(true);
        expect(acceptsFile(accept, { name: 'a', type: 'image/png' })).toBe(true);
        expect(acceptsFile(accept, { name: 'a', type: 'imagex/png' })).toBe(false);
        expect(acceptsFile(accept, { name: 'a', type: 'text/html' })).toBe(false);
        expect(acceptsFile(accept, { name: 'a', type: '' })).toBe(false);
    });
});
