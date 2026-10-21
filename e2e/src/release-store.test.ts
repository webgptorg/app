import { describe, expect, it } from 'vitest';

import { contentTypeOf, storePath } from './release-store.ts';

describe('storePath', () => {
    it('maps plain paths under the root', () => {
        expect(storePath('/releases', '/ui/latest.json')).toBe('/releases/ui/latest.json');
        expect(storePath('/releases', '/ui/0.0.0-dryrun.1/engine-ui.tar.zst')).toBe(
            '/releases/ui/0.0.0-dryrun.1/engine-ui.tar.zst',
        );
        expect(storePath('/releases', '/release-log/ui-1.0.0+build.1.json')).toBe(
            '/releases/release-log/ui-1.0.0+build.1.json',
        );
    });

    it.each([
        undefined,
        '',
        'ui/latest.json',
        '/',
        '/ui/',
        '/ui//latest.json',
        '/../etc/passwd',
        '/ui/../../etc/passwd',
        '/ui/%2e%2e/x',
        '/ui/.hidden',
        '/ui/latest.json?x=1',
        '/ui/latest.json#x',
        '/ui\\latest.json',
        `/${'a'.repeat(600)}`,
    ])('refuses %j', (path) => {
        expect(storePath('/releases', path)).toBeNull();
    });
});

describe('contentTypeOf', () => {
    it('knows JSON and zstd, and nothing else', () => {
        expect(contentTypeOf('/releases/ui/latest.json')).toBe('application/json');
        expect(contentTypeOf('/releases/ui/1/engine-ui.tar.zst')).toBe('application/zstd');
        expect(contentTypeOf('/releases/x.html')).toBe('application/octet-stream');
    });
});
