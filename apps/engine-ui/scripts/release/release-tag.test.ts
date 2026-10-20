import { describe, expect, it } from 'vitest';

import { parseReleaseTag } from './release-tag.ts';

describe('parseReleaseTag', () => {
    it('accepts exactly ui-v<package version> as a release', () => {
        expect(parseReleaseTag('ui-v0.1.0', '0.1.0')).toEqual({ kind: 'release', tag: 'ui-v0.1.0', version: '0.1.0' });
        expect(parseReleaseTag('ui-v1.2.3-rc.1', '1.2.3-rc.1')).toMatchObject({ kind: 'release' });
    });

    it('accepts ui-v0.0.0-dryrun.<n> as a dry run whatever the package version', () => {
        expect(parseReleaseTag('ui-v0.0.0-dryrun.1', '0.1.0')).toEqual({
            kind: 'dry-run',
            tag: 'ui-v0.0.0-dryrun.1',
            version: '0.0.0-dryrun.1',
        });
        expect(parseReleaseTag('ui-v0.0.0-dryrun.42', '3.0.0')).toMatchObject({ version: '0.0.0-dryrun.42' });
    });

    it.each([
        ['another version', 'ui-v0.2.0'],
        ['no prefix', 'v0.1.0'],
        ['a branch-like suffix', 'ui-v0.1.0-x'],
        ['dry run 0', 'ui-v0.0.0-dryrun.0'],
        ['a dry run with a leading zero', 'ui-v0.0.0-dryrun.01'],
        ['a dry run of another version', 'ui-v0.1.0-dryrun.1'],
        ['a dry run with a suffix', 'ui-v0.0.0-dryrun.1.2'],
        ['an empty tag', ''],
    ])('refuses %s', (_case, tag) => {
        expect(parseReleaseTag(tag, '0.1.0').kind).toBe('invalid');
    });

    it('refuses a package version that is not semver or is the reserved dry-run version', () => {
        expect(JSON.stringify(parseReleaseTag('ui-v1', '1'))).toMatch(/"invalid".*semver/);
        expect(JSON.stringify(parseReleaseTag('ui-v0.0.0-dryrun.x', '0.0.0-dryrun.x'))).toMatch(/"invalid".*reserved/);
    });
});
